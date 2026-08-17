//! SerpAPI (Google engine) as the last-resort web-search provider.
//!
//! Brave and SearXNG answer in ~0.7–1.1s; this one measured 3.3s against the
//! live API, and its free tier is 100 searches per MONTH rather than per day. It
//! exists for the case the unmetered providers have all failed — a wearer with
//! no answer is worse than a wearer with a slow one — and [`is_metered`] keeps
//! the search policy from spending that quota on any query the free providers
//! already answered.
//!
//! [`is_metered`]: WebSearchProvider::is_metered
//!
//! Every field a provider hands back is untrusted data: markup is stripped, only
//! `http(s)` links survive, and the count is capped before the planner or the
//! wearer ever sees it.
//!
//! The API key is write-only. It is held in memory, sent only as the `api_key`
//! parameter to the pinned SerpAPI endpoint, and never appears in `Debug`, logs,
//! errors, or results.

use std::time::Duration;

use futures::StreamExt as _;
use reqwest::{StatusCode, Url};

use crate::external::web_search::{
    WebSearchError, WebSearchGeo, WebSearchProvider, WebSearchResult, WebSearchResults,
};

const SERPAPI_SEARCH_URL: &str = "https://serpapi.com/search.json";

/// 6s where the unmetered providers get 4s.
///
/// Measured latency against the live API is 3.3s — the slowest of the three by a
/// factor of three. A 4s budget would turn an ordinary response into a `Timeout`
/// on the one provider that only ever runs after everything else has already
/// failed, spending the wait and the quota for nothing.
const SERPAPI_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_QUERY_BYTES: usize = 512;
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
/// The Pin speaks its answers. More than a handful of results is unusable as
/// speech and only widens the untrusted surface the planner has to reason over.
const MAX_RESULTS: usize = 3;

#[derive(Clone)]
pub struct SerpApiClient {
    http: reqwest::Client,
    endpoint: String,
    api_key: Option<String>,
}

/// Redacted by hand: the derived form would print the API key.
impl std::fmt::Debug for SerpApiClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SerpApiClient")
            .field("endpoint", &self.endpoint)
            .field("api_key_configured", &self.api_key.is_some())
            .finish()
    }
}

impl SerpApiClient {
    pub fn new(http: reqwest::Client, api_key: Option<String>) -> Self {
        Self {
            http,
            endpoint: SERPAPI_SEARCH_URL.to_string(),
            // A settings write that clears the key leaves an empty string
            // behind; that is unconfigured, not a key that will 401 later.
            api_key: api_key.filter(|key| !key.trim().is_empty()),
        }
    }

    /// Whether an API key is present. The search policy is gated on this so a Pin
    /// without one never lists a fallback it cannot run.
    pub fn is_configured(&self) -> bool {
        self.api_key.is_some()
    }

    async fn fetch_json(&self, url: Url) -> Result<serde_json::Value, WebSearchError> {
        let requested_url = url.clone();

        let response = self
            .http
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(SERPAPI_TIMEOUT)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    WebSearchError::Timeout
                } else {
                    WebSearchError::Transport
                }
            })?;

        // The production HTTP client disables redirects. Keep this check here as
        // a defense for independently constructed clients and tests: this vendor
        // authenticates by query parameter, so a followed redirect would hand
        // the key itself to another host.
        if response.url() != &requested_url {
            return Err(WebSearchError::ProviderUnavailable);
        }

        match response.status() {
            StatusCode::TOO_MANY_REQUESTS => return Err(WebSearchError::RateLimited),
            StatusCode::BAD_REQUEST
            | StatusCode::UNAUTHORIZED
            | StatusCode::FORBIDDEN
            | StatusCode::UNPROCESSABLE_ENTITY => return Err(WebSearchError::ProviderRejected),
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
impl WebSearchProvider for SerpApiClient {
    fn name(&self) -> &'static str {
        "serpapi"
    }

    async fn search(
        &self,
        query: &str,
        geo: &WebSearchGeo,
    ) -> Result<WebSearchResults, WebSearchError> {
        let api_key = self
            .api_key
            .as_deref()
            .ok_or(WebSearchError::NotConfigured)?;
        let query = validate_query(query)?;
        let url = build_url(&self.endpoint, query, api_key, geo)?;

        // One `search` call costs a caller at most `SERPAPI_TIMEOUT` even if the
        // per-request timeout above is somehow not honoured; the turn's budget
        // must not be open-ended on the slowest provider we have.
        let json = tokio::time::timeout(SERPAPI_TIMEOUT, self.fetch_json(url))
            .await
            .map_err(|_| WebSearchError::Timeout)??;
        parse_search_response(&json)
    }

    /// The free tier is 100 searches per MONTH. The policy in `web_search` reads
    /// this to keep the provider out of the routine hedge, so a single busy day
    /// cannot silently burn the month's quota; flipping it to `false` would spend
    /// the allowance on queries the free providers were already answering.
    fn is_metered(&self) -> bool {
        true
    }
}

/// Build the pinned request URL, spelling this vendor's dialect of the wearer's
/// geography: `gl` wants a LOWERCASE country, `hl` the bare language, and
/// `location` a human place string. Verified against the live API — geography is
/// correctness here, not decoration: an un-geo'd query answers as if the wearer
/// were in America.
fn build_url(
    endpoint: &str,
    query: &str,
    api_key: &str,
    geo: &WebSearchGeo,
) -> Result<Url, WebSearchError> {
    let mut url = Url::parse(endpoint).map_err(|_| WebSearchError::ProviderUnavailable)?;
    url.query_pairs_mut()
        .append_pair("engine", "google")
        .append_pair("q", query)
        .append_pair("num", &MAX_RESULTS.to_string())
        .append_pair("gl", &geo.country.to_lowercase())
        .append_pair("hl", &geo.language)
        .append_pair("api_key", api_key);
    if let Some(place) = geo
        .place
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        url.query_pairs_mut().append_pair("location", place);
    }
    Ok(url)
}

fn validate_query(query: &str) -> Result<&str, WebSearchError> {
    let query = query.trim();
    if query.is_empty() || query.len() > MAX_QUERY_BYTES {
        return Err(WebSearchError::InvalidRequest);
    }
    // Whitespace-exempt, matching the sibling providers and the shared typed
    // argument validator. A bare `is_control()` rejection would fail a query
    // containing a newline only AFTER it had passed typed validation and
    // grounding, and `InvalidRequest` is not retryable, so the turn would die on
    // a character the rest of the stack considers ordinary whitespace.
    if query.chars().any(|character| {
        character == '\0' || (character.is_control() && !character.is_whitespace())
    }) {
        return Err(WebSearchError::InvalidRequest);
    }
    Ok(query)
}

fn parse_search_response(json: &serde_json::Value) -> Result<WebSearchResults, WebSearchError> {
    // A bad key or a malformed parameter comes back as a top-level `error`
    // string, sometimes over a 200. Without this check that response reads as a
    // missing `organic_results` and would be reported as an unparseable body,
    // which sends the caller looking at the wrong thing entirely.
    if json
        .get("error")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|error| !error.trim().is_empty())
    {
        return Err(WebSearchError::ProviderRejected);
    }

    let entries = json
        .get("organic_results")
        .and_then(serde_json::Value::as_array)
        .ok_or(WebSearchError::InvalidResponse)?;

    let results: Vec<WebSearchResult> = entries
        .iter()
        .filter_map(parse_result)
        .take(MAX_RESULTS)
        .collect();

    if results.is_empty() {
        return Err(WebSearchError::NotFound);
    }
    Ok(WebSearchResults { results })
}

/// This engine names its fields `link` and `snippet` where the sibling providers
/// say `url` and `description`; the shared result type is what the planner sees.
fn parse_result(entry: &serde_json::Value) -> Option<WebSearchResult> {
    let source_url = entry.get("link").and_then(serde_json::Value::as_str)?;
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
    let description = strip_markup(
        entry
            .get("snippet")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default(),
    );
    // `date` is this engine's freshness label ("2 days ago", "Jan 5, 2026") and
    // is present on only some entries.
    let age = entry
        .get("date")
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

/// Snippets arrive mostly plain, but they are provider-controlled text that the
/// Pin speaks and the planner may cite an exact span from, so tags and entities
/// have to be gone before either happens rather than merely rendered away.
fn strip_markup(value: &str) -> String {
    let mut text = String::with_capacity(value.len());
    // Buffered rather than a bare bool: a `<` that does not begin a tag is
    // ordinary text ("best if pH < 7 and the water is soft"), and treating it as
    // one silently deleted the rest of the field. Only `<` followed by a letter
    // or `/` opens a tag; anything else — including an unterminated one at end
    // of input — is flushed back out as the literal text it was.
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

    fn client_with_key() -> SerpApiClient {
        SerpApiClient::new(reqwest::Client::new(), Some("secret-key".into()))
    }

    /// The quota guard the whole design rests on: `web_search`'s "metered last"
    /// rule reads this, so a `false` here would quietly put a 100-per-MONTH
    /// provider into the routine hedge.
    #[test]
    fn this_provider_declares_itself_metered() {
        assert!(
            client_with_key().is_metered(),
            "the last-resort policy depends on this being true"
        );
        assert_eq!(client_with_key().name(), "serpapi");
    }

    #[test]
    fn a_missing_api_key_is_reported_not_guessed() {
        let client = SerpApiClient::new(reqwest::Client::new(), None);
        assert!(!client.is_configured());

        // `block_on` runs without a tokio reactor on purpose: reaching the
        // network (or even the timeout) from here would fail loudly rather than
        // pass quietly.
        let error = futures::executor::block_on(client.search("who won", &WebSearchGeo::default()))
            .expect_err("an unconfigured client must not reach the network");
        assert_eq!(error, WebSearchError::NotConfigured);
        assert!(!error.is_transient(), "a missing key never fixes itself");
    }

    #[test]
    fn a_blank_key_counts_as_unconfigured() {
        // A settings write that clears the key leaves an empty string behind.
        let client = SerpApiClient::new(reqwest::Client::new(), Some("   ".into()));
        assert!(!client.is_configured());
    }

    #[test]
    fn debug_output_never_carries_the_api_key() {
        let rendered = format!("{:?}", client_with_key());
        assert!(!rendered.contains("secret-key"), "{rendered}");
        assert!(rendered.contains("api_key_configured: true"), "{rendered}");
    }

    #[test]
    fn the_wearers_geography_is_spelled_in_this_vendors_dialect() {
        let url = build_url(
            SERPAPI_SEARCH_URL,
            "netto opening hours",
            "secret-key",
            &WebSearchGeo::default(),
        )
        .expect("the pinned endpoint parses");
        let params: Vec<(String, String)> = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        let value = |name: &str| {
            params
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        };

        assert_eq!(value("engine"), Some("google"));
        assert_eq!(value("q"), Some("netto opening hours"));
        assert_eq!(value("num"), Some("3"));
        assert_eq!(value("gl"), Some("dk"), "this vendor wants it lowercase");
        assert_eq!(value("hl"), Some("en"));
        assert_eq!(value("location"), Some("Copenhagen, Denmark"));
    }

    #[test]
    fn a_geography_without_a_place_omits_the_parameter_rather_than_sending_an_empty_one() {
        let geo = WebSearchGeo {
            country: "DK".into(),
            language: "en".into(),
            place: None,
        };
        let url = build_url(SERPAPI_SEARCH_URL, "q", "secret-key", &geo).expect("parses");
        assert!(url.query_pairs().all(|(key, _)| key != "location"), "{url}");
    }

    #[test]
    fn queries_are_bounded_and_control_free() {
        assert_eq!(validate_query("  "), Err(WebSearchError::InvalidRequest));
        assert_eq!(
            validate_query(&"a".repeat(MAX_QUERY_BYTES + 1)),
            Err(WebSearchError::InvalidRequest)
        );
        assert_eq!(validate_query("news\nabout"), Ok("news\nabout"));
        assert_eq!(
            validate_query("news\u{0}about"),
            Err(WebSearchError::InvalidRequest)
        );
        assert_eq!(validate_query("  danish news  "), Ok("danish news"));
    }

    /// Shaped after a captured live response: `link`/`snippet`/`date`, plus the
    /// sibling top-level keys the parser must simply ignore.
    #[test]
    fn results_are_parsed_stripped_and_capped() {
        let json = serde_json::json!({
            "search_metadata": {"status": "Success"},
            "search_parameters": {"engine": "google", "gl": "dk", "hl": "en"},
            "search_information": {"total_results": 4},
            "related_questions": [{"question": "ignored"}],
            "ai_overview": {"text_blocks": ["ignored"]},
            "pagination": {"current": 1},
            "organic_results": [
                {
                    "position": 1,
                    "title": "<strong>Copenhagen</strong> weather",
                    "link": "https://example.org/a",
                    "snippet": "It&#39;s <strong>cold</strong>&nbsp;today.",
                    "source": "Example",
                    "displayed_link": "https://example.org › a",
                    "date": "2 days ago"
                },
                {"position": 2, "title": "Second", "link": "https://example.org/b", "snippet": "b"},
                {"position": 3, "title": "Third", "link": "https://example.org/c", "snippet": "c"},
                {"position": 4, "title": "Fourth", "link": "https://example.org/d", "snippet": "d"}
            ]
        });

        let parsed = parse_search_response(&json).expect("organic results parse");
        assert_eq!(
            parsed.results.len(),
            MAX_RESULTS,
            "the speakable cap must hold"
        );
        assert_eq!(parsed.results[0].title, "Copenhagen weather");
        assert_eq!(parsed.results[0].description, "It's cold today.");
        assert_eq!(parsed.results[0].source_url, "https://example.org/a");
        assert_eq!(parsed.results[0].age.as_deref(), Some("2 days ago"));
        assert_eq!(parsed.results[1].age, None);
    }

    /// How a bad key or a malformed parameter actually comes back — and it can
    /// arrive over a 200, so the status mapping alone would miss it.
    #[test]
    fn a_top_level_error_field_is_a_rejection_not_an_unparseable_body() {
        let json = serde_json::json!({
            "error": "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key"
        });
        assert_eq!(
            parse_search_response(&json),
            Err(WebSearchError::ProviderRejected)
        );
    }

    #[test]
    fn an_empty_or_shapeless_response_is_an_error_not_an_empty_answer() {
        assert_eq!(
            parse_search_response(&serde_json::json!({"organic_results": []})),
            Err(WebSearchError::NotFound)
        );
        assert_eq!(
            parse_search_response(&serde_json::json!({"search_metadata": {"status": "Success"}})),
            Err(WebSearchError::InvalidResponse)
        );
    }

    #[test]
    fn a_non_web_link_is_dropped_rather_than_handed_to_the_planner() {
        let json = serde_json::json!({
            "organic_results": [
                {"title": "Bad", "snippet": "x", "link": "javascript:alert(1)"},
                {"title": "Also bad", "snippet": "x", "link": "file:///etc/passwd"},
                {"title": "Good", "snippet": "x", "link": "https://example.org/ok"}
            ]
        });

        let parsed = parse_search_response(&json).expect("the one good result survives");
        assert_eq!(parsed.results.len(), 1);
        assert_eq!(parsed.results[0].source_url, "https://example.org/ok");
    }

    #[test]
    fn markup_stripping_keeps_ordinary_text_intact() {
        // "&amp;lt;script&amp;gt;" must survive as literal text, not become a
        // tag: the planner may cite this span and the Pin will speak it.
        assert_eq!(strip_markup("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
        assert_eq!(
            strip_markup("best if pH < 7 and the water is soft"),
            "best if pH < 7 and the water is soft"
        );
        assert_eq!(strip_markup("a <b>bold</b> claim"), "a bold claim");
        assert_eq!(strip_markup("truncated <spa"), "truncated <spa");
        assert_eq!(strip_markup("a\u{0}b"), "a b");
    }
}
