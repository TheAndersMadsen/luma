//! Web search as a *policy* over several providers, rather than one vendor.
//!
//! # Why this exists
//!
//! One provider was never enough for a wearable. Measured against the live APIs
//! with this deployment's own keys:
//!
//! | provider | latency | limit                  |
//! |----------|---------|------------------------|
//! | Brave    | 0.7–1.0s| 1 req/sec, ~2k/month   |
//! | SearXNG  | ~1.1s   | none (self-hosted)     |
//! | SerpAPI  | 3.3s    | 100/month (free tier)  |
//!
//! Brave's one-per-second limit is not a corner case: a single turn can search
//! twice, and back-to-back the second call returned `429` — which reached the
//! wearer as "the web-search backend could not be reached". A second provider is
//! the structural fix, not a nicety.
//!
//! # The policy: hedge, don't race
//!
//! The obvious reading of "race them and take the first" is to fire every
//! provider on every query. That is the wrong trade here, for three measured
//! reasons: it would exhaust SerpAPI's 100 free calls in days, it would
//! *self-inflict* Brave 429s by design, and on a battery-powered Pin every extra
//! radio request is power the wearer paid for.
//!
//! So this hedges instead ("The Tail at Scale"): start ONE provider, and only if
//! it has not answered within [`HEDGE_DELAY`] start a second one concurrently
//! and take whichever finishes first. A second request is spent only when the
//! first is actually slow — which is exactly when a wearer is standing in
//! silence waiting for an answer.
//!
//! Three rules make it concrete:
//!
//! 1. **Rate-aware primary.** If the preferred provider cannot be called *right
//!    now* without waiting for its own rate limit, it is not the primary — the
//!    unmetered provider goes first instead. This is precisely the case that
//!    broke: the turn's second search no longer waits or 429s, it goes to
//!    SearXNG.
//! 2. **Fast failover.** A provider that fails *immediately* does not consume
//!    the hedge delay; the next one starts at once.
//! 3. **Metered last.** A metered provider (SerpAPI, 100/month) is never part of
//!    the routine hedge. It answers only when the unmetered providers have all
//!    failed, so a slow month cannot silently burn the quota.
//!
//! # Geography is part of correctness
//!
//! Brave defaults to `country: us` when asked for nothing, so an un-geo'd Pin in
//! Copenhagen searched as if it were in America — measured: `netto opening hours
//! copenhagen` returned `.com` and Yelp pages, and with `country=DK` the same
//! query returned `visitcopenhagen.dk` and `tiendeo.dk`. Opening hours, prices
//! and "near me" are the whole point of search on this device, so [`WebSearchGeo`]
//! travels with every query and each provider spells it in its own dialect.

use std::sync::Arc;
use std::time::Duration;

/// How long the primary gets alone before a second provider is started.
///
/// Set just under the measured p50 of the fast providers (~0.7–1.1s): a healthy
/// primary almost always answers first and the hedge never fires, while a
/// genuinely slow one is overlapped early enough to matter to a person waiting.
const HEDGE_DELAY: Duration = Duration::from_millis(700);

/// Where the wearer is. Sent with every query; each provider spells it its own way.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebSearchGeo {
    /// ISO-3166-1 alpha-2, e.g. `DK`. Brave wants it uppercase, SerpAPI lower.
    pub country: String,
    /// ISO-639-1 base language the *answers* should be in, e.g. `en`. The wearer
    /// speaks English while living in Denmark, so language and country differ on
    /// purpose — this is not a locale.
    pub language: String,
    /// A human place string for providers that accept one, e.g.
    /// `Copenhagen, Denmark`. Only SerpAPI takes it today.
    pub place: Option<String>,
}

impl WebSearchGeo {
    /// The `language-COUNTRY` form SearXNG expects (`en-DK`): English answers,
    /// Danish results. Verified against a live instance — the first hit for a
    /// Copenhagen query was `visitcopenhagen.dk`.
    pub fn locale(&self) -> String {
        format!("{}-{}", self.language, self.country.to_uppercase())
    }
}

impl Default for WebSearchGeo {
    /// Denmark/English/Copenhagen. A neutral default is not neutral in practice:
    /// providers fall back to the United States, which is a silently wrong answer
    /// for this wearer rather than an absent one.
    fn default() -> Self {
        Self {
            country: "DK".to_owned(),
            language: "en".to_owned(),
            place: Some("Copenhagen, Denmark".to_owned()),
        }
    }
}

/// Failure taxonomy shared by every provider.
///
/// Lives here rather than in one vendor's module because the policy below has to
/// reason about *all* providers' failures uniformly. `brave_search` re-exports it
/// under its historical name so existing call sites are unchanged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WebSearchError {
    NotConfigured,
    InvalidRequest,
    Timeout,
    Transport,
    ProviderRejected,
    RateLimited,
    ProviderUnavailable,
    ResponseTooLarge,
    NotFound,
    InvalidResponse,
}

impl WebSearchError {
    /// Errors where one immediate retry is reasonable: the provider or the
    /// network hiccuped, and the same query may succeed right away. Definitive
    /// outcomes (not configured, rejected, rate limited, not found, oversized)
    /// must not retry — a retry there burns the deadline or the quota.
    pub const fn is_transient(self) -> bool {
        matches!(
            self,
            Self::Timeout | Self::Transport | Self::ProviderUnavailable
        )
    }

    pub const fn kind(self) -> &'static str {
        match self {
            Self::NotConfigured => "not_configured",
            Self::InvalidRequest => "invalid_request",
            Self::Timeout => "timeout",
            Self::Transport => "transport",
            Self::ProviderRejected => "provider_rejected",
            Self::RateLimited => "rate_limited",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::ResponseTooLarge => "response_too_large",
            Self::NotFound => "not_found",
            Self::InvalidResponse => "invalid_response",
        }
    }
}

impl std::fmt::Display for WebSearchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.kind())
    }
}

impl std::error::Error for WebSearchError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebSearchResult {
    pub title: String,
    pub description: String,
    pub source_url: String,
    /// The provider's own freshness label ("2 days ago") when it publishes one.
    pub age: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebSearchResults {
    pub results: Vec<WebSearchResult>,
}

/// One search backend.
#[tonic::async_trait]
pub trait WebSearchProvider: Send + Sync {
    /// Stable identifier for logs and traces. Never wearer-visible.
    fn name(&self) -> &'static str;

    async fn search(
        &self,
        query: &str,
        geo: &WebSearchGeo,
    ) -> Result<WebSearchResults, WebSearchError>;

    /// Whether this provider can be called RIGHT NOW without first waiting out
    /// its own rate limit. The policy uses this to pick a primary that will
    /// actually start immediately, instead of one that will sit in a sleep.
    async fn ready_now(&self) -> bool {
        true
    }

    /// Whether calls are a scarce, billed resource. A metered provider is kept
    /// out of the routine hedge and used only as a last resort.
    fn is_metered(&self) -> bool {
        false
    }
}

/// Ceiling on ONE `web_search` tool call, across every provider it tries.
///
/// The agentic loop executes a tool with a bare `await` — there is no timeout
/// above this call (`chat_turn_loop.rs`). Left uncapped the cascade can run
/// Brave (4s) then SearXNG (4s, started at the 700ms hedge) then SerpAPI (6s):
/// nearly 11 seconds inside a single tool, spent to *maybe* rescue one query,
/// with a model step still to come on either side. A search that has not
/// succeeded in five seconds has stopped being useful to someone standing there
/// waiting for speech.
const WEB_SEARCH_TOTAL_BUDGET: Duration = Duration::from_secs(5);

/// Budget that must remain before the metered provider is worth starting.
///
/// SerpAPI measured 3.3s. Starting it with less than this left buys a request
/// the budget will cut off before it answers — a billed call, thrown away, that
/// also delays the honest failure.
const METERED_MIN_REMAINING: Duration = Duration::from_millis(4_000);

/// How long a cached answer stays servable, by what kind of question it was.
///
/// A news query and a "who is X" query do not age alike, and treating them alike
/// is how a cache either serves stale news or throws away answers that were
/// still perfectly good. Deliberately coarse: three classes decided by the same
/// kind of lexical cue the freshness obligation already uses, with no extra
/// model call to classify — a classifier that costs a model step would spend
/// more time than the cache saves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QuestionClass {
    /// "latest", "the news", "who won", "what happened", "today".
    Live,
    /// "how much", "price of", "opening hours", "what time does".
    Perishable,
    /// Everything else: definitions, biography, how-to.
    Durable,
}

impl QuestionClass {
    fn of(query: &str) -> Self {
        let lower = query.to_lowercase();
        let has = |cue: &str| lower.contains(cue);
        if [
            "latest",
            "the news",
            "who won",
            "what happened",
            "today",
            "right now",
            "breaking",
        ]
        .iter()
        .any(|cue| has(cue))
        {
            return Self::Live;
        }
        if [
            "how much",
            "price",
            "cost of",
            "opening hours",
            "what time does",
            "open today",
            "in stock",
        ]
        .iter()
        .any(|cue| has(cue))
        {
            return Self::Perishable;
        }
        Self::Durable
    }

    const fn ttl(self) -> Duration {
        match self {
            Self::Live => Duration::from_secs(90),
            Self::Perishable => Duration::from_secs(6 * 60 * 60),
            Self::Durable => Duration::from_secs(24 * 60 * 60),
        }
    }
}

/// Bound on retained queries. The Pin is memory-constrained and a wearer asks a
/// bounded number of distinct questions; this is a leak guard, not a hit-rate
/// tuning knob.
const CACHE_MAX_ENTRIES: usize = 64;

struct CacheEntry {
    results: WebSearchResults,
    stored_at: tokio::time::Instant,
    ttl: Duration,
}

/// The multi-provider search the assistant actually calls.
#[derive(Clone)]
pub struct WebSearch {
    /// Unmetered providers in preference order (fastest first).
    unmetered: Vec<Arc<dyn WebSearchProvider>>,
    /// Metered fallback, tried only when every unmetered provider failed.
    metered: Option<Arc<dyn WebSearchProvider>>,
    geo: WebSearchGeo,
    hedge_delay: Duration,
    /// Answers already paid for, shared by every clone of this handle — the
    /// quota and the latency both belong to the deployment, not to one turn.
    cache: Arc<std::sync::Mutex<std::collections::HashMap<String, CacheEntry>>>,
}

impl std::fmt::Debug for WebSearch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebSearch")
            .field(
                "unmetered",
                &self.unmetered.iter().map(|p| p.name()).collect::<Vec<_>>(),
            )
            .field("metered", &self.metered.as_ref().map(|p| p.name()))
            .field("geo", &self.geo)
            .finish()
    }
}

impl WebSearch {
    /// Build the policy from providers in preference order.
    ///
    /// Placement is derived from [`WebSearchProvider::is_metered`], never from
    /// the caller's ordering: a metered provider dropped into the middle of the
    /// list would otherwise join the routine hedge and quietly bill every query.
    /// Declaring the property on the provider makes that mistake unrepresentable.
    pub fn new(providers: Vec<Arc<dyn WebSearchProvider>>, geo: WebSearchGeo) -> Self {
        let mut unmetered = Vec::new();
        let mut metered = None;
        for provider in providers {
            if provider.is_metered() {
                // First metered provider wins; a second would be a quota to
                // spend with no policy for choosing between them.
                metered.get_or_insert(provider);
            } else {
                unmetered.push(provider);
            }
        }
        Self {
            unmetered,
            metered,
            geo,
            hedge_delay: HEDGE_DELAY,
            cache: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    /// Cache key: the query reduced to what actually determines the answer, plus
    /// the geography (a Copenhagen answer must never be served to a query asked
    /// with different geo). Case, punctuation and spacing vary with however the
    /// model phrased the search and would otherwise make every lookup a miss.
    fn cache_key(&self, query: &str) -> String {
        let normalized: String = query
            .to_lowercase()
            .chars()
            .map(|character| {
                if character.is_alphanumeric() {
                    character
                } else {
                    ' '
                }
            })
            .collect();
        let normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
        format!(
            "{}|{}|{}",
            normalized,
            self.geo.country.to_uppercase(),
            self.geo.language
        )
    }

    /// A cached answer that is still within its class's TTL, if any.
    fn cached(&self, key: &str) -> Option<WebSearchResults> {
        let mut cache = self.cache.lock().ok()?;
        let entry = cache.get(key)?;
        if entry.stored_at.elapsed() <= entry.ttl {
            return Some(entry.results.clone());
        }
        // Expired: drop it rather than leave it to be re-checked forever.
        cache.remove(key);
        None
    }

    fn remember(&self, key: String, class: QuestionClass, results: &WebSearchResults) {
        let Ok(mut cache) = self.cache.lock() else {
            return;
        };
        if cache.len() >= CACHE_MAX_ENTRIES {
            // Coarse eviction: drop the oldest. A wearer's working set is small,
            // so exact LRU accounting would cost more than it saves.
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.stored_at)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(
            key,
            CacheEntry {
                results: results.clone(),
                stored_at: tokio::time::Instant::now(),
                ttl: class.ttl(),
            },
        );
    }

    /// Whether any provider at all is configured. The tool catalog is gated on
    /// this, so a Pin with no search configured never advertises the tool.
    pub fn is_configured(&self) -> bool {
        !self.unmetered.is_empty() || self.metered.is_some()
    }

    /// Provider names in the order they would be attempted, for diagnostics.
    pub fn provider_names(&self) -> Vec<&'static str> {
        self.unmetered
            .iter()
            .chain(self.metered.iter())
            .map(|provider| provider.name())
            .collect()
    }

    /// Run the hedged policy described in the module docs.
    ///
    /// A cached answer short-circuits everything; otherwise the whole cascade is
    /// capped by [`WEB_SEARCH_TOTAL_BUDGET`], because nothing above this call
    /// bounds it.
    pub async fn search(&self, query: &str) -> Result<WebSearchResults, WebSearchError> {
        if !self.is_configured() {
            return Err(WebSearchError::NotConfigured);
        }
        let key = self.cache_key(query);
        if let Some(hit) = self.cached(&key) {
            tracing::debug!("web search served from cache");
            return Ok(hit);
        }
        let class = QuestionClass::of(query);
        let results = tokio::time::timeout(WEB_SEARCH_TOTAL_BUDGET, self.search_uncached(query))
            .await
            .unwrap_or(Err(WebSearchError::Timeout))?;
        self.remember(key, class, &results);
        Ok(results)
    }

    async fn search_uncached(&self, query: &str) -> Result<WebSearchResults, WebSearchError> {
        let started = tokio::time::Instant::now();

        // Rule 1 — rate-aware primary. A provider that would have to sleep out
        // its own rate limit is demoted behind one that can start immediately,
        // preserving preference order inside each group. This is what sends a
        // turn's SECOND search to the unmetered provider instead of stalling on
        // (or 429-ing against) the rate-limited one.
        let mut ordered: Vec<&Arc<dyn WebSearchProvider>> = Vec::new();
        let mut waiting: Vec<&Arc<dyn WebSearchProvider>> = Vec::new();
        for provider in &self.unmetered {
            if provider.ready_now().await {
                ordered.push(provider);
            } else {
                waiting.push(provider);
            }
        }
        ordered.extend(waiting);

        let mut last_error = WebSearchError::NotConfigured;
        let mut index = 0;
        while index < ordered.len() {
            let primary = ordered[index];
            let hedge = ordered.get(index + 1).copied();

            match self.attempt_with_hedge(primary, hedge, query).await {
                Ok(results) => return Ok(results),
                // Rule 2 — fast failover. `attempt_with_hedge` already gave the
                // hedge (if any) its chance, so both are spent; step past them.
                Err(error) => {
                    last_error = error;
                    index += if hedge.is_some() { 2 } else { 1 };
                }
            }
        }

        // Rule 3 — metered last. Only once every unmetered provider has failed,
        // so a scarce quota is never spent on a query the free ones answered.
        // A definitive answer is not a reason to spend the quota. If every
        // unmetered provider agreed the query has no results (or is malformed),
        // a metered call would buy the same answer for one of 100 monthly
        // searches. Escalate only for INFRASTRUCTURE failures — the ones where
        // nobody actually answered the question.
        let answered_definitively = matches!(
            last_error,
            WebSearchError::NotFound | WebSearchError::InvalidRequest
        );
        // Nor is it worth starting a 3.3s provider with less budget than that
        // left: the cap would cut it off mid-flight, billing a call whose answer
        // is thrown away and delaying the honest failure the wearer could have
        // heard sooner.
        let remaining = WEB_SEARCH_TOTAL_BUDGET.saturating_sub(started.elapsed());
        if remaining < METERED_MIN_REMAINING {
            tracing::debug!(
                remaining_ms = remaining.as_millis() as u64,
                "skipping the metered provider: not enough budget left to finish it"
            );
            return Err(last_error);
        }
        if let (Some(metered), false) = (&self.metered, answered_definitively) {
            tracing::debug!(
                provider = metered.name(),
                "falling back to the metered search provider"
            );
            return metered.search(query, &self.geo).await;
        }
        Err(last_error)
    }

    /// Run `primary`, and if it has not finished within the hedge delay start
    /// `hedge` alongside it and take whichever answers first.
    async fn attempt_with_hedge(
        &self,
        primary: &Arc<dyn WebSearchProvider>,
        hedge: Option<&Arc<dyn WebSearchProvider>>,
        query: &str,
    ) -> Result<WebSearchResults, WebSearchError> {
        let primary_call = primary.search(query, &self.geo);
        tokio::pin!(primary_call);

        let Some(hedge) = hedge else {
            return primary_call.await;
        };

        // Give the primary the delay to itself. A result OR an immediate failure
        // both end the wait — failing fast must not cost the hedge delay.
        match tokio::time::timeout(self.hedge_delay, &mut primary_call).await {
            Ok(Ok(results)) => return Ok(results),
            Ok(Err(error)) => {
                tracing::debug!(
                    provider = primary.name(),
                    error = error.kind(),
                    "primary search failed; starting the next provider immediately"
                );
                return hedge.search(query, &self.geo).await;
            }
            // Still running: hedge it rather than keep the wearer waiting.
            Err(_) => {}
        }
        tracing::debug!(
            primary = primary.name(),
            hedge = hedge.name(),
            "primary is slow; hedging"
        );

        let hedge_call = hedge.search(query, &self.geo);
        tokio::pin!(hedge_call);

        // First OK wins. If one fails, keep waiting on the other rather than
        // discarding a request already in flight.
        let mut primary_error: Option<WebSearchError> = None;
        let mut hedge_error: Option<WebSearchError> = None;
        loop {
            tokio::select! {
                result = &mut primary_call, if primary_error.is_none() => match result {
                    Ok(results) => return Ok(results),
                    Err(error) => {
                        if let Some(hedge_error) = hedge_error {
                            return Err(pick_error(error, hedge_error));
                        }
                        primary_error = Some(error);
                    }
                },
                result = &mut hedge_call, if hedge_error.is_none() => match result {
                    Ok(results) => return Ok(results),
                    Err(error) => {
                        if let Some(primary_error) = primary_error {
                            return Err(pick_error(primary_error, error));
                        }
                        hedge_error = Some(error);
                    }
                },
            }
        }
    }
}

/// Which of two failures to report. A definitive answer ("nothing matched")
/// beats a transport-ish one, because it tells the caller something true about
/// the query rather than about the network.
fn pick_error(first: WebSearchError, second: WebSearchError) -> WebSearchError {
    // "Nothing matched" outranks everything: some provider actually ran the
    // query and answered it, which the caller can turn into a truthful empty
    // result rather than an outage.
    if first == WebSearchError::NotFound || second == WebSearchError::NotFound {
        return WebSearchError::NotFound;
    }
    // Otherwise prefer a definitive failure over a transient one: a rejected key
    // or a malformed query is something an operator can fix, while "the network
    // hiccuped" tells them nothing.
    match (first.is_transient(), second.is_transient()) {
        (false, _) => first,
        (true, false) => second,
        (true, true) => first,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A provider whose latency and outcome the test dictates, so the POLICY is
    /// what is under test rather than any real network.
    struct FakeProvider {
        name: &'static str,
        delay: Duration,
        outcome: Result<&'static str, WebSearchError>,
        ready: bool,
        metered: bool,
        calls: Arc<AtomicUsize>,
    }

    impl FakeProvider {
        fn new(
            name: &'static str,
            delay_ms: u64,
            outcome: Result<&'static str, WebSearchError>,
        ) -> Self {
            Self {
                name,
                delay: Duration::from_millis(delay_ms),
                outcome,
                ready: true,
                metered: false,
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }
        fn not_ready(mut self) -> Self {
            self.ready = false;
            self
        }
        fn metered(mut self) -> Self {
            self.metered = true;
            self
        }
        fn counter(&self) -> Arc<AtomicUsize> {
            self.calls.clone()
        }
        fn shared(self) -> Arc<dyn WebSearchProvider> {
            Arc::new(self)
        }
    }

    #[tonic::async_trait]
    impl WebSearchProvider for FakeProvider {
        fn name(&self) -> &'static str {
            self.name
        }
        async fn search(
            &self,
            _query: &str,
            _geo: &WebSearchGeo,
        ) -> Result<WebSearchResults, WebSearchError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(self.delay).await;
            self.outcome.map(|title| WebSearchResults {
                results: vec![WebSearchResult {
                    title: title.to_owned(),
                    description: String::new(),
                    source_url: "https://example.dk".to_owned(),
                    age: None,
                }],
            })
        }
        async fn ready_now(&self) -> bool {
            self.ready
        }
        fn is_metered(&self) -> bool {
            self.metered
        }
    }

    fn first_title(results: &WebSearchResults) -> &str {
        &results.results[0].title
    }

    /// The common case: a healthy primary answers inside the hedge delay, and
    /// the second provider is never called. This is what keeps the design from
    /// doubling every query's cost.
    #[tokio::test(start_paused = true)]
    async fn a_fast_primary_answers_alone_and_never_spends_a_second_request() {
        let backup = FakeProvider::new("backup", 50, Ok("backup"));
        let backup_calls = backup.counter();
        let search = WebSearch::new(
            vec![
                FakeProvider::new("primary", 100, Ok("primary")).shared(),
                backup.shared(),
            ],
            WebSearchGeo::default(),
        );

        let results = search.search("q").await.expect("primary answers");
        assert_eq!(first_title(&results), "primary");
        assert_eq!(
            backup_calls.load(Ordering::SeqCst),
            0,
            "a healthy primary must not cost a hedge request"
        );
    }

    /// A slow primary is overlapped, and whichever finishes first wins — the
    /// "race" the wearer actually feels.
    #[tokio::test(start_paused = true)]
    async fn a_slow_primary_is_hedged_and_the_faster_answer_wins() {
        let search = WebSearch::new(
            vec![
                FakeProvider::new("slow", 5_000, Ok("slow")).shared(),
                FakeProvider::new("quick", 100, Ok("quick")).shared(),
            ],
            WebSearchGeo::default(),
        );

        let started = tokio::time::Instant::now();
        let results = search.search("q").await.expect("the hedge answers");
        assert_eq!(first_title(&results), "quick");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the wearer must not wait for the slow provider: {:?}",
            started.elapsed()
        );
    }

    /// An immediate failure must not cost the hedge delay before the next
    /// provider starts.
    #[tokio::test(start_paused = true)]
    async fn a_failing_primary_fails_over_without_burning_the_hedge_delay() {
        let search = WebSearch::new(
            vec![
                FakeProvider::new("broken", 0, Err(WebSearchError::RateLimited)).shared(),
                FakeProvider::new("healthy", 100, Ok("healthy")).shared(),
            ],
            WebSearchGeo::default(),
        );

        let started = tokio::time::Instant::now();
        let results = search.search("q").await.expect("failover answers");
        assert_eq!(first_title(&results), "healthy");
        assert!(
            started.elapsed() < HEDGE_DELAY,
            "failover must not wait out the hedge delay: {:?}",
            started.elapsed()
        );
    }

    /// THE REGRESSION THIS DESIGN EXISTS FOR: the turn's second search, when the
    /// rate-limited provider has no slot free, goes to the unmetered provider
    /// immediately instead of stalling on it or being told 429.
    #[tokio::test(start_paused = true)]
    async fn a_provider_that_cannot_run_now_is_not_made_the_primary() {
        let rate_limited = FakeProvider::new("rate_limited", 100, Ok("rate_limited")).not_ready();
        let rate_limited_calls = rate_limited.counter();
        let search = WebSearch::new(
            vec![
                rate_limited.shared(),
                FakeProvider::new("unmetered", 100, Ok("unmetered")).shared(),
            ],
            WebSearchGeo::default(),
        );

        let results = search
            .search("q")
            .await
            .expect("the ready provider answers");
        assert_eq!(
            first_title(&results),
            "unmetered",
            "a provider that must wait for its rate limit must not lead"
        );
        assert_eq!(
            rate_limited_calls.load(Ordering::SeqCst),
            0,
            "and it must not be called at all while it has no slot"
        );
    }

    /// The metered provider protects a scarce monthly quota: never part of the
    /// routine hedge, only a last resort.
    #[tokio::test(start_paused = true)]
    async fn the_metered_provider_is_untouched_while_a_free_one_answers() {
        let metered = FakeProvider::new("metered", 10, Ok("metered")).metered();
        let metered_calls = metered.counter();
        let search = WebSearch::new(
            vec![
                FakeProvider::new("free", 100, Ok("free")).shared(),
                metered.shared(),
            ],
            WebSearchGeo::default(),
        );

        let results = search.search("q").await.expect("the free provider answers");
        assert_eq!(first_title(&results), "free");
        assert_eq!(
            metered_calls.load(Ordering::SeqCst),
            0,
            "a billed provider must not be spent on a query the free one answered"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_metered_provider_answers_once_every_free_one_has_failed() {
        let search = WebSearch::new(
            vec![
                FakeProvider::new("free_a", 10, Err(WebSearchError::Transport)).shared(),
                FakeProvider::new("free_b", 10, Err(WebSearchError::ProviderUnavailable)).shared(),
                FakeProvider::new("metered", 10, Ok("metered"))
                    .metered()
                    .shared(),
            ],
            WebSearchGeo::default(),
        );

        let results = search.search("q").await.expect("the last resort answers");
        assert_eq!(first_title(&results), "metered");
    }

    /// "Nothing matched" is an ANSWER, and answers are not worth a billed call.
    /// Escalating there would spend one of 100 monthly searches to be told the
    /// same thing by a third index.
    #[tokio::test(start_paused = true)]
    async fn a_definitive_no_results_does_not_escalate_to_the_metered_provider() {
        let metered = FakeProvider::new("metered", 10, Ok("metered")).metered();
        let metered_calls = metered.counter();
        let search = WebSearch::new(
            vec![
                FakeProvider::new("free", 10, Err(WebSearchError::NotFound)).shared(),
                metered.shared(),
            ],
            WebSearchGeo::default(),
        );

        let error = search
            .search("q")
            .await
            .expect_err("no results is an error");
        assert_eq!(error, WebSearchError::NotFound);
        assert_eq!(
            metered_calls.load(Ordering::SeqCst),
            0,
            "a definitive empty answer must not be re-bought from a metered index"
        );
    }

    /// The tool is executed with a bare `await` — nothing above it bounds the
    /// cascade. Without this cap a wearer can wait ~11s inside one tool call
    /// with a model step still to come on either side.
    #[tokio::test(start_paused = true)]
    async fn the_whole_cascade_is_capped_so_one_tool_call_cannot_run_away() {
        let search = WebSearch::new(
            vec![FakeProvider::new("glacial", 30_000, Ok("glacial")).shared()],
            WebSearchGeo::default(),
        );

        let started = tokio::time::Instant::now();
        let error = search.search("q").await.expect_err("the cap fires");
        assert_eq!(error, WebSearchError::Timeout);
        assert!(
            started.elapsed() <= WEB_SEARCH_TOTAL_BUDGET + Duration::from_millis(50),
            "one tool call must not exceed its budget: {:?}",
            started.elapsed()
        );
    }

    /// A billed provider that cannot finish inside what is left is a call spent
    /// for nothing AND a delayed failure.
    #[tokio::test(start_paused = true)]
    async fn the_metered_provider_is_skipped_when_too_little_budget_remains() {
        let metered = FakeProvider::new("metered", 10, Ok("metered")).metered();
        let metered_calls = metered.counter();
        let search = WebSearch::new(
            vec![
                // Fails only after most of the budget is gone.
                FakeProvider::new("slow_failure", 4_500, Err(WebSearchError::Transport)).shared(),
                metered.shared(),
            ],
            WebSearchGeo::default(),
        );

        let error = search.search("q").await.expect_err("nothing answered");
        assert_eq!(error, WebSearchError::Transport);
        assert_eq!(
            metered_calls.load(Ordering::SeqCst),
            0,
            "a billed call must not be started when the cap would cut it off"
        );
    }

    /// A repeat question must not pay latency or quota twice.
    #[tokio::test(start_paused = true)]
    async fn a_repeated_question_is_served_from_cache_without_touching_a_provider() {
        let provider = FakeProvider::new("provider", 100, Ok("answer"));
        let calls = provider.counter();
        let search = WebSearch::new(vec![provider.shared()], WebSearchGeo::default());

        let first = search
            .search("Who won the last Danish election?")
            .await
            .unwrap();
        assert_eq!(first_title(&first), "answer");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Same question, spelled differently: normalization must still hit.
        let again = search
            .search("who won the LAST danish election")
            .await
            .unwrap();
        assert_eq!(first_title(&again), "answer");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "a repeat must not reach the provider again"
        );
    }

    /// News goes stale in minutes; a definition does not. Serving them on one
    /// TTL either lies about the news or throws away good answers.
    #[tokio::test(start_paused = true)]
    async fn a_live_question_expires_quickly_while_a_durable_one_persists() {
        assert_eq!(
            QuestionClass::of("what happened in Denmark today"),
            QuestionClass::Live
        );
        assert_eq!(
            QuestionClass::of("how much does a metro ticket cost"),
            QuestionClass::Perishable
        );
        assert_eq!(
            QuestionClass::of("who is Niels Bohr"),
            QuestionClass::Durable
        );

        let provider = FakeProvider::new("provider", 10, Ok("answer"));
        let calls = provider.counter();
        let search = WebSearch::new(vec![provider.shared()], WebSearchGeo::default());

        search.search("what happened today").await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Past the Live TTL the answer must be fetched again, not re-served.
        tokio::time::sleep(QuestionClass::Live.ttl() + Duration::from_secs(1)).await;
        search.search("what happened today").await.unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "stale news must not be served as if it were current"
        );
    }

    /// The cache must never serve one country's answer to another's query.
    #[tokio::test(start_paused = true)]
    async fn the_cache_key_separates_geographies() {
        let copenhagen = WebSearch::new(Vec::new(), WebSearchGeo::default());
        let elsewhere = WebSearch::new(
            Vec::new(),
            WebSearchGeo {
                country: "US".to_owned(),
                language: "en".to_owned(),
                place: None,
            },
        );
        assert_ne!(
            copenhagen.cache_key("opening hours"),
            elsewhere.cache_key("opening hours"),
            "a Copenhagen answer must not be reused for a US query"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn with_nothing_configured_search_reports_it_rather_than_pretending() {
        let search = WebSearch::new(Vec::new(), WebSearchGeo::default());
        assert!(!search.is_configured());
        assert_eq!(
            search.search("q").await.expect_err("must fail"),
            WebSearchError::NotConfigured
        );
    }

    /// Geography is spelled differently by each provider; the wearer's is
    /// English answers with Danish results.
    #[test]
    fn the_default_geography_is_english_answers_from_denmark() {
        let geo = WebSearchGeo::default();
        assert_eq!(geo.country, "DK");
        assert_eq!(geo.language, "en");
        assert_eq!(geo.locale(), "en-DK");
        assert_eq!(geo.place.as_deref(), Some("Copenhagen, Denmark"));
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use std::sync::Arc;

    /// End-to-end through the real providers and policy against a live,
    /// operator-controlled self-hosted SearXNG. Ignored because it needs that
    /// external instance.
    ///
    /// This is the test the unit tests cannot be: it proves the parser matches
    /// what a real instance actually emits, and that the Copenhagen geography
    /// survives all the way to the wire.
    #[tokio::test]
    #[ignore = "requires a running SearXNG; set SEARXNG_TEST_URL (see deploy/searxng)"]
    async fn a_live_searxng_answers_a_copenhagen_query_through_the_policy() {
        let base_url = std::env::var("SEARXNG_TEST_URL").expect("SEARXNG_TEST_URL");
        let provider =
            crate::external::searxng::SearxngClient::new(reqwest::Client::new(), Some(base_url));
        assert!(provider.is_configured());

        let search = WebSearch::new(vec![Arc::new(provider)], WebSearchGeo::default());
        let results = search
            .search("netto opening hours copenhagen")
            .await
            .expect("a live SearXNG answers");

        assert!(
            !results.results.is_empty(),
            "a live query must return results"
        );
        for result in &results.results {
            assert!(
                result.source_url.starts_with("http"),
                "every result must contain a usable URL: {result:?}"
            );
            assert!(
                !result.title.is_empty(),
                "results must be speakable: {result:?}"
            );
        }
        eprintln!(
            "live searxng returned {} results; first = {}",
            results.results.len(),
            results.results[0].source_url
        );
    }
}

#[cfg(test)]
mod live_multiprovider_tests {
    use super::*;
    use std::sync::Arc;

    /// Build the REAL policy from the REAL providers, exactly as
    /// `services::aibus::build_web_search` does, from environment credentials.
    fn live_search() -> Option<WebSearch> {
        let http = reqwest::Client::new();
        let mut providers: Vec<Arc<dyn WebSearchProvider>> = Vec::new();

        let brave = crate::external::brave_search::BraveSearchClient::new(
            http.clone(),
            std::env::var("BRAVE_SEARCH_API_KEY").ok(),
        );
        if brave.is_configured() {
            providers.push(Arc::new(brave));
        }
        let searxng = crate::external::searxng::SearxngClient::new(
            http.clone(),
            std::env::var("SEARXNG_BASE_URL").ok(),
        );
        if searxng.is_configured() {
            providers.push(Arc::new(searxng));
        }
        let serpapi = crate::external::serpapi::SerpApiClient::new(
            http,
            std::env::var("SERPAPI_API_KEY").ok(),
        );
        if serpapi.is_configured() {
            providers.push(Arc::new(serpapi));
        }
        (!providers.is_empty()).then(|| WebSearch::new(providers, WebSearchGeo::default()))
    }

    /// The wearer's three goals, against live providers: correct (Copenhagen),
    /// fast, and no errors — including the two-searches-in-one-turn case that
    /// originally failed with a 429 reported as "backend could not be reached".
    #[tokio::test]
    #[ignore = "live: set BRAVE_SEARCH_API_KEY / SEARXNG_BASE_URL / SERPAPI_API_KEY"]
    async fn the_wearers_prompts_answer_correctly_and_quickly_against_live_providers() {
        let search = live_search().expect("at least one provider must be configured");
        eprintln!("providers: {:?}", search.provider_names());

        // 1. CORRECT — a Copenhagen question must return Danish sources. This is
        //    the case that silently returned US pages before the geo fix.
        let started = std::time::Instant::now();
        let local = search
            .search("netto opening hours copenhagen")
            .await
            .expect("a local question must answer");
        let local_ms = started.elapsed().as_millis();
        let hosts: Vec<&str> = local
            .results
            .iter()
            .map(|result| result.source_url.as_str())
            .collect();
        eprintln!("[1] local question {local_ms}ms -> {hosts:?}");
        assert!(!local.results.is_empty());
        assert!(
            hosts.iter().any(|url| url.contains(".dk")),
            "a Copenhagen question must surface Danish sources, got {hosts:?}"
        );

        // 2. NO ERRORS — two searches back to back. Brave's free tier allows one
        //    per second, so before pacing + failover the second reliably 429'd.
        let started = std::time::Instant::now();
        let first = search.search("danish parliament latest news").await;
        let second = search.search("copenhagen metro ticket price").await;
        eprintln!(
            "[2] two searches in {}ms -> {:?} / {:?}",
            started.elapsed().as_millis(),
            first.as_ref().map(|r| r.results.len()),
            second.as_ref().map(|r| r.results.len())
        );
        assert!(first.is_ok(), "first search failed: {:?}", first.err());
        assert!(
            second.is_ok(),
            "the SECOND search in a turn must not fail: {:?}",
            second.err()
        );

        // 3. FAST — a repeat must be served from cache, not re-fetched.
        let started = std::time::Instant::now();
        let repeat = search
            .search("netto opening hours copenhagen")
            .await
            .expect("repeat answers");
        let repeat_ms = started.elapsed().as_millis();
        eprintln!("[3] repeat {repeat_ms}ms (first was {local_ms}ms)");
        assert_eq!(
            repeat.results, local.results,
            "cache must return the same answer"
        );
        assert!(
            repeat_ms < 50,
            "a cached repeat must be immediate, took {repeat_ms}ms"
        );

        // 4. Every result must be speakable and attributable.
        for result in &local.results {
            assert!(
                !result.title.trim().is_empty(),
                "unspeakable result: {result:?}"
            );
            assert!(result.source_url.starts_with("http"), "bad url: {result:?}");
        }
    }
}
