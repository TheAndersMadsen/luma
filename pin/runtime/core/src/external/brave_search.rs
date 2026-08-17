//! Bounded, read-only Brave Search lookup used by the semantic agent loop.
//!
//! Wikipedia answers "what is this entity"; it cannot answer anything current,
//! local, or off-encyclopedia. This provider covers that gap with the same
//! contract: every result is untrusted data. The agentic runtime may select an
//! exact UTF-8 span from a snippet for another read-only tool, but it never
//! treats provider text as instructions or native-action authority.
//!
//! The subscription token is write-only. It is held in memory, sent only as the
//! `X-Subscription-Token` header to the pinned Brave endpoint, and never
//! appears in `Debug`, logs, errors, or results.

use std::time::Duration;

use futures::StreamExt as _;
use reqwest::{StatusCode, Url};

const BRAVE_SEARCH_API_URL: &str = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_SEARCH_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_QUERY_BYTES: usize = 512;
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
/// The Pin speaks its answers. More than a handful of results is unusable as
/// speech and only widens the untrusted surface the planner has to reason over.
const MAX_RESULTS: usize = 3;

/// Minimum gap between two Brave requests.
///
/// Brave's Free plan permits exactly ONE request per second — its own 429 body
/// says so (`"plan":"Free","rate_limit":1`). One agentic turn can legitimately
/// issue two searches, and back-to-back they arrive inside the same second, so
/// the SECOND one reliably failed. Reproduced against the live API: two
/// concurrent calls return 200 and 429.
///
/// That failure reached the wearer as "the web-search backend could not be
/// reached", which is not what happened — the backend was reached and answered
/// that we asked too fast. Pacing is the honest fix: the plan's limit is a known
/// constant, so wait for the slot instead of spending the call to be told.
/// 1100ms rather than exactly 1000ms because the limit is enforced on the
/// provider's clock, not ours.
const BRAVE_MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(1100);

#[derive(Clone)]
pub struct BraveSearchClient {
    http: reqwest::Client,
    endpoint: String,
    api_key: Option<String>,
    /// When the last request went out, shared by every clone of this client.
    ///
    /// The rate limit belongs to the SUBSCRIPTION, not to a caller, and the
    /// client is cloned into each turn's tool broker — so per-clone state would
    /// pace nothing. `Arc<Mutex<..>>` is what makes the gate global.
    last_request: std::sync::Arc<tokio::sync::Mutex<Option<tokio::time::Instant>>>,
}

/// Redacted by hand: the derived form would print the subscription token.
impl std::fmt::Debug for BraveSearchClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BraveSearchClient")
            .field("endpoint", &self.endpoint)
            .field("api_key_configured", &self.api_key.is_some())
            .finish()
    }
}

/// The result and error shapes are shared by every search provider and live in
/// `web_search`, which owns the multi-provider policy. Re-exported here under
/// their historical names so existing call sites are untouched.
pub use crate::external::web_search::{
    WebSearchError as BraveSearchError, WebSearchResult as BraveSearchResult,
    WebSearchResults as BraveSearchResults,
};

#[tonic::async_trait]
impl crate::external::web_search::WebSearchProvider for BraveSearchClient {
    fn name(&self) -> &'static str {
        "brave"
    }

    async fn search(
        &self,
        query: &str,
        geo: &crate::external::web_search::WebSearchGeo,
    ) -> Result<BraveSearchResults, BraveSearchError> {
        self.search_with_geo(query, geo).await
    }

    /// Whether a request would go out NOW rather than sleep out the plan's
    /// one-per-second limit.
    ///
    /// This is what lets the policy route a turn's SECOND search to an unmetered
    /// provider instead of stalling here for a second or spending the call to be
    /// told 429 — the exact failure a wearer hit. It only reads the gate; it
    /// never takes the slot, so asking does not consume anything.
    async fn ready_now(&self) -> bool {
        let last = self.last_request.lock().await;
        last.is_none_or(|previous| previous.elapsed() >= BRAVE_MIN_REQUEST_INTERVAL)
    }
}

impl BraveSearchClient {
    pub fn new(http: reqwest::Client, api_key: Option<String>) -> Self {
        Self {
            http,
            endpoint: BRAVE_SEARCH_API_URL.to_string(),
            api_key: api_key.filter(|key| !key.trim().is_empty()),
            last_request: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    /// Wait until this subscription is allowed another request.
    ///
    /// The lock is held ACROSS the wait on purpose: it is what serialises two
    /// callers that arrive together, so they leave one interval apart instead of
    /// both waking and racing into the same second.
    async fn await_rate_limit_slot(&self) {
        let mut last = self.last_request.lock().await;
        if let Some(previous) = *last {
            let elapsed = previous.elapsed();
            if elapsed < BRAVE_MIN_REQUEST_INTERVAL {
                tokio::time::sleep(BRAVE_MIN_REQUEST_INTERVAL - elapsed).await;
            }
        }
        *last = Some(tokio::time::Instant::now());
    }

    /// Whether a subscription token is present. The tool catalog is gated on
    /// this so an unconfigured Pin never advertises a search it cannot run.
    pub fn is_configured(&self) -> bool {
        self.api_key.is_some()
    }

    pub async fn search(&self, query: &str) -> Result<BraveSearchResults, BraveSearchError> {
        self.search_with_geo(query, &crate::external::web_search::WebSearchGeo::default())
            .await
    }

    pub async fn search_with_geo(
        &self,
        query: &str,
        geo: &crate::external::web_search::WebSearchGeo,
    ) -> Result<BraveSearchResults, BraveSearchError> {
        let api_key = self
            .api_key
            .as_deref()
            .ok_or(BraveSearchError::NotConfigured)?;
        let query = validate_query(query)?;
        // The pace gate sits INSIDE the timeout so one `search` call still costs
        // a caller at most `BRAVE_SEARCH_TIMEOUT` — waiting for a slot must not
        // silently extend the tool's worst case and eat the turn's budget.
        tokio::time::timeout(BRAVE_SEARCH_TIMEOUT, async {
            self.await_rate_limit_slot().await;
            self.search_validated(query, geo, api_key).await
        })
        .await
        .map_err(|_| BraveSearchError::Timeout)?
    }

    async fn search_validated(
        &self,
        query: &str,
        geo: &crate::external::web_search::WebSearchGeo,
        api_key: &str,
    ) -> Result<BraveSearchResults, BraveSearchError> {
        let mut url =
            Url::parse(&self.endpoint).map_err(|_| BraveSearchError::ProviderUnavailable)?;
        url.query_pairs_mut()
            .append_pair("q", query)
            .append_pair("count", &MAX_RESULTS.to_string())
            // Where the wearer is. Asked for nothing, Brave answers as the
            // United States — measured: "netto opening hours copenhagen"
            // returned Yelp and `.com` pages, and the same query with
            // `country=DK` returned `visitcopenhagen.dk` and `tiendeo.dk`.
            // Opening hours, prices and "near me" are most of what search is
            // for on this device, so an absent country is a silently wrong
            // answer rather than a missing one.
            .append_pair("country", &geo.country.to_uppercase())
            // Answers in the wearer's language, results from their country:
            // they speak English and live in Denmark, so these differ on
            // purpose.
            .append_pair("search_lang", &geo.language)
            // Web results only: news/video/discussion blocks add untrusted text
            // and richer embedded markup for no answer quality.
            .append_pair("result_filter", "web")
            .append_pair("safesearch", "moderate")
            // Ask Brave not to wrap query terms in <strong>. `strip_markup`
            // still runs; this only reduces how much it has to remove.
            .append_pair("text_decorations", "0")
            .append_pair("extra_snippets", "0");

        let json = self.fetch_json(url, api_key).await?;
        parse_search_response(&json)
    }

    async fn fetch_json(
        &self,
        url: Url,
        api_key: &str,
    ) -> Result<serde_json::Value, BraveSearchError> {
        let requested_url = url.clone();

        let response = self
            .http
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header("X-Subscription-Token", api_key)
            .timeout(BRAVE_SEARCH_TIMEOUT)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    BraveSearchError::Timeout
                } else {
                    BraveSearchError::Transport
                }
            })?;

        // The production HTTP client disables redirects. Keep this check here
        // as a defense for independently constructed clients and tests: a
        // redirect would replay the subscription token to another host.
        if response.url() != &requested_url {
            return Err(BraveSearchError::ProviderUnavailable);
        }

        match response.status() {
            StatusCode::TOO_MANY_REQUESTS => return Err(BraveSearchError::RateLimited),
            StatusCode::BAD_REQUEST
            | StatusCode::UNAUTHORIZED
            | StatusCode::FORBIDDEN
            | StatusCode::UNPROCESSABLE_ENTITY => return Err(BraveSearchError::ProviderRejected),
            status if !status.is_success() => return Err(BraveSearchError::ProviderUnavailable),
            _ => {}
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(BraveSearchError::ResponseTooLarge);
        }

        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| BraveSearchError::Transport)?;
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(BraveSearchError::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| BraveSearchError::InvalidResponse)
    }
}

fn validate_query(query: &str) -> Result<&str, BraveSearchError> {
    let query = query.trim();
    if query.is_empty() || query.len() > MAX_QUERY_BYTES {
        return Err(BraveSearchError::InvalidRequest);
    }
    // Whitespace-exempt, matching the sibling providers and the shared typed
    // argument validator. A bare `is_control()` rejection would fail a query
    // containing a newline only AFTER it had passed typed validation and
    // grounding, and `InvalidRequest` is not retryable, so the turn would die
    // on a character the rest of the stack considers ordinary whitespace.
    if query.chars().any(|character| {
        character == '\0' || (character.is_control() && !character.is_whitespace())
    }) {
        return Err(BraveSearchError::InvalidRequest);
    }
    Ok(query)
}

fn parse_search_response(json: &serde_json::Value) -> Result<BraveSearchResults, BraveSearchError> {
    let entries = json
        .get("web")
        .and_then(|web| web.get("results"))
        .and_then(serde_json::Value::as_array)
        .ok_or(BraveSearchError::InvalidResponse)?;

    let results: Vec<BraveSearchResult> = entries
        .iter()
        .filter_map(parse_result)
        .take(MAX_RESULTS)
        .collect();

    if results.is_empty() {
        return Err(BraveSearchError::NotFound);
    }
    Ok(BraveSearchResults { results })
}

fn parse_result(entry: &serde_json::Value) -> Option<BraveSearchResult> {
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
    let description = strip_markup(
        entry
            .get("description")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default(),
    );
    let age = entry
        .get("age")
        .and_then(serde_json::Value::as_str)
        .map(strip_markup)
        .filter(|age| !age.is_empty());

    Some(BraveSearchResult {
        title,
        description,
        source_url: parsed.to_string(),
        age,
    })
}

/// Brave marks matched terms with `<strong>` and encodes a few entities. The
/// Pin speaks these strings, and the planner may cite an exact span from one,
/// so tags have to be gone before either happens — not merely rendered away.
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

    #[test]
    fn a_missing_subscription_token_is_reported_not_guessed() {
        let client = BraveSearchClient::new(reqwest::Client::new(), None);
        assert!(!client.is_configured());

        let error = futures::executor::block_on(client.search("who won"))
            .expect_err("an unconfigured client must not reach the network");
        assert_eq!(error, BraveSearchError::NotConfigured);
        assert!(!error.is_transient(), "a missing key never fixes itself");
    }

    /// REGRESSION (reproduced against the live API): Brave's Free plan allows
    /// ONE request per second. A turn that searched twice sent both inside the
    /// same second and the second came back 429 — surfaced to the wearer as
    /// "the web-search backend could not be reached", which was never true.
    ///
    /// The clock is paused, so this pins the pacing without costing a real
    /// second: `tokio::time::sleep` auto-advances and `Instant::elapsed` reads
    /// the same virtual clock.
    #[tokio::test(start_paused = true)]
    async fn a_second_search_waits_for_the_plans_rate_limit_slot() {
        let client = BraveSearchClient::new(reqwest::Client::new(), Some("token".into()));
        let start = tokio::time::Instant::now();

        client.await_rate_limit_slot().await;
        assert!(
            start.elapsed() < BRAVE_MIN_REQUEST_INTERVAL,
            "the first request of a turn must not be delayed"
        );

        client.await_rate_limit_slot().await;
        assert!(
            start.elapsed() >= BRAVE_MIN_REQUEST_INTERVAL,
            "a second search must wait for its slot rather than spend the call \
             being told it asked too fast: waited {:?}",
            start.elapsed()
        );
    }

    /// The limit belongs to the SUBSCRIPTION, and the client is cloned into each
    /// turn's tool broker — so a gate that lived per-clone would pace nothing.
    #[tokio::test(start_paused = true)]
    async fn the_rate_limit_gate_is_shared_by_every_clone_of_the_client() {
        let client = BraveSearchClient::new(reqwest::Client::new(), Some("token".into()));
        let cloned = client.clone();
        let start = tokio::time::Instant::now();

        client.await_rate_limit_slot().await;
        cloned.await_rate_limit_slot().await;

        assert!(
            start.elapsed() >= BRAVE_MIN_REQUEST_INTERVAL,
            "a clone shares the subscription, so it must share the gate: waited {:?}",
            start.elapsed()
        );
    }

    /// `ready_now` is the hinge of the multi-provider policy: it is how a turn's
    /// second search learns to go elsewhere instead of stalling here. Asking must
    /// not itself consume the slot, or merely checking would starve the caller.
    #[tokio::test(start_paused = true)]
    async fn readiness_reports_the_rate_limit_slot_without_consuming_it() {
        use crate::external::web_search::WebSearchProvider as _;

        let client = BraveSearchClient::new(reqwest::Client::new(), Some("token".into()));
        assert!(client.ready_now().await, "an idle client is ready");
        assert!(
            client.ready_now().await,
            "asking twice must not have taken the slot"
        );

        client.await_rate_limit_slot().await;
        assert!(
            !client.ready_now().await,
            "immediately after a request the slot is spent, so the policy must \
             route the next search to another provider"
        );

        tokio::time::sleep(BRAVE_MIN_REQUEST_INTERVAL).await;
        assert!(
            client.ready_now().await,
            "once the interval has elapsed the slot is free again"
        );
    }

    #[test]
    fn a_blank_token_counts_as_unconfigured() {
        // A settings write that clears the key leaves an empty string behind.
        let client = BraveSearchClient::new(reqwest::Client::new(), Some("   ".into()));
        assert!(!client.is_configured());
    }

    #[test]
    fn debug_output_never_carries_the_subscription_token() {
        let client = BraveSearchClient::new(reqwest::Client::new(), Some("secret-token".into()));
        let rendered = format!("{client:?}");
        assert!(!rendered.contains("secret-token"), "{rendered}");
        assert!(rendered.contains("api_key_configured: true"), "{rendered}");
    }

    #[test]
    fn queries_are_bounded_and_control_free() {
        assert_eq!(validate_query("  "), Err(BraveSearchError::InvalidRequest));
        assert_eq!(
            validate_query(&"a".repeat(MAX_QUERY_BYTES + 1)),
            Err(BraveSearchError::InvalidRequest)
        );
        // A newline is whitespace, not a control-character rejection: the
        // typed validator upstream already lets one through, so rejecting it
        // here would kill the turn on a character everything else tolerates.
        assert_eq!(validate_query("news\nabout"), Ok("news\nabout"));
        assert_eq!(
            validate_query("news\u{0}about"),
            Err(BraveSearchError::InvalidRequest)
        );
        assert_eq!(validate_query("  danish news  "), Ok("danish news"));
    }

    #[test]
    fn results_are_parsed_stripped_and_capped() {
        let json = serde_json::json!({
            "web": {"results": [
                {
                    "title": "<strong>Copenhagen</strong> weather",
                    "description": "It&#39;s <strong>cold</strong>&nbsp;today.",
                    "url": "https://example.org/a",
                    "age": "2 days ago"
                },
                {"title": "Second", "description": "b", "url": "https://example.org/b"},
                {"title": "Third", "description": "c", "url": "https://example.org/c"},
                {"title": "Fourth", "description": "d", "url": "https://example.org/d"}
            ]}
        });

        let parsed = parse_search_response(&json).expect("web results parse");
        assert_eq!(
            parsed.results.len(),
            MAX_RESULTS,
            "the speakable cap must hold"
        );
        assert_eq!(parsed.results[0].title, "Copenhagen weather");
        assert_eq!(parsed.results[0].description, "It's cold today.");
        assert_eq!(parsed.results[0].age.as_deref(), Some("2 days ago"));
        assert_eq!(parsed.results[1].age, None);
    }

    #[test]
    fn a_non_web_url_is_dropped_rather_than_handed_to_the_planner() {
        let json = serde_json::json!({
            "web": {"results": [
                {"title": "Bad", "description": "x", "url": "javascript:alert(1)"},
                {"title": "Also bad", "description": "x", "url": "file:///etc/passwd"},
                {"title": "Good", "description": "x", "url": "https://example.org/ok"}
            ]}
        });

        let parsed = parse_search_response(&json).expect("the one good result survives");
        assert_eq!(parsed.results.len(), 1);
        assert_eq!(parsed.results[0].source_url, "https://example.org/ok");
    }

    #[test]
    fn an_empty_or_shapeless_response_is_an_error_not_an_empty_answer() {
        assert_eq!(
            parse_search_response(&serde_json::json!({"web": {"results": []}})),
            Err(BraveSearchError::NotFound)
        );
        assert_eq!(
            parse_search_response(&serde_json::json!({"query": {"original": "x"}})),
            Err(BraveSearchError::InvalidResponse)
        );
    }

    #[test]
    fn markup_stripping_does_not_reconstruct_tags_from_entities() {
        // "&amp;lt;script&amp;gt;" must survive as literal text, not become a
        // tag: the planner may cite this span and the Pin will speak it.
        assert_eq!(strip_markup("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
        assert_eq!(strip_markup("a\u{0}b"), "a b");
    }

    #[test]
    fn a_bare_less_than_is_text_not_the_start_of_a_tag() {
        // The regression this guards: one unconditional "inside tag" flag ate
        // everything after a comparison sign, so a snippet the Pin would speak
        // lost its second half.
        assert_eq!(
            strip_markup("best if pH < 7 and the water is soft"),
            "best if pH < 7 and the water is soft"
        );
        assert_eq!(strip_markup("5 > 3 is true"), "5 > 3 is true");
        // A real tag still goes.
        assert_eq!(strip_markup("a <b>bold</b> claim"), "a bold claim");
        // An unterminated tag is flushed as literal text rather than dropped.
        assert_eq!(strip_markup("truncated <spa"), "truncated <spa");
    }
}
