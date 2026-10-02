//! Web search, private SearXNG first, with the existing SerpApi adapter as a
//! protected availability fallback (`MODE_SERP_API` in cosmos's backend
//! enumeration).
//!
//! This backs the assistant's `web_search` tool. The result is folded into the
//! ReAct transcript as an **observation**, so it must be compact enough for a
//! model to reason over and honest about what it did and did not find.
//!
//! Evidence labels: **observed**, the device-facing tool surface identifies
//! web retrieval as `MODE_SERP_API`; **implemented**, SearXNG is this
//! deployment's private adapter for that surface; **unknown**, this does not
//! claim Humane operated SearXNG or used the same result-ranking policy.

use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, de::DeserializeOwned};

use super::{BackendError, http, key, refused};

pub(crate) const SEARXNG_BASE_URL_VAR: &str = "COSMOS_SEARXNG_BASE_URL";
const SERPAPI_KEY_VAR: &str = "COSMOS_SERPAPI_KEY";
const SERPAPI_BASE_URL: &str = "https://serpapi.com/search.json";
/// The broad-web engines `cosmos/search/settings.yml` enables. From a
/// datacenter address no single one answers every query, so results from any
/// of them are a real answer. Results only from the low-weight last resort
/// (Search.ch) are degraded.
const BROAD_WEB_SEARXNG_ENGINES: &[&str] = &["bing", "resulthunter", "yahoo", "yandex"];
/// The operator test's query: a common name every broad-web engine indexes.
const PROBE_QUERY: &str = "OpenAI";

/// SearXNG is on the private service network, so it should fail quickly enough
/// for the assistant to give an honest unavailable observation in the same
/// turn. The shared client retains its stricter four-second connect bound.
const SEARCH_TIMEOUT: Duration = Duration::from_secs(5);

/// A wearer utterance can be large, but sending an unbounded string to a search
/// engine is neither useful nor safe. Whitespace is collapsed before this cap
/// is applied at a UTF-8 boundary.
const MAX_QUERY_BYTES: usize = 512;

/// A malicious or malfunctioning metasearch engine must not make Cosmos buffer
/// an arbitrary response before JSON decoding.
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

const MAX_TITLE_BYTES: usize = 192;
const MAX_SNIPPET_BYTES: usize = 640;

/// How many organic results to summarize into the observation. The transcript
/// rides in the model's context on every subsequent step of the run, so this is
/// deliberately small.
const MAX_RESULTS: usize = 4;

enum SelectedBackend {
    Searxng(String),
    SerpApi(String),
}

#[derive(Deserialize)]
struct SerpResponse {
    #[serde(default)]
    error: Option<String>,
    answer_box: Option<AnswerBox>,
    knowledge_graph: Option<KnowledgeGraph>,
    #[serde(default)]
    organic_results: Vec<Organic>,
}

#[derive(Deserialize)]
struct AnswerBox {
    #[serde(default)]
    answer: String,
    #[serde(default)]
    snippet: String,
}

#[derive(Deserialize)]
struct KnowledgeGraph {
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
struct Organic {
    #[serde(default)]
    title: String,
    #[serde(default)]
    snippet: String,
}

#[derive(Deserialize)]
struct SearxResponse {
    #[serde(default)]
    results: Vec<SearxResult>,
}

#[derive(Deserialize)]
struct SearxResult {
    #[serde(default)]
    title: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    engine: String,
    #[serde(default)]
    engines: Vec<String>,
}

#[derive(Debug, PartialEq)]
struct SearxSearch {
    observation: String,
    broad_web_answered: bool,
}

/// Search the web and render the findings as an observation.
pub async fn search(query: &str) -> Result<String, BackendError> {
    let query = bounded_query(query).ok_or(BackendError::NoResult)?;
    let backend = selected_backend().ok_or(BackendError::NotConfigured)?;
    let fallback_serpapi_key = matches!(&backend, SelectedBackend::Searxng(_))
        .then(|| key(SERPAPI_KEY_VAR))
        .flatten();
    search_selected(
        &query,
        backend,
        fallback_serpapi_key.as_deref(),
        SERPAPI_BASE_URL,
    )
    .await
}

/// Verify the configured private SearXNG endpoint without falling back to a
/// different provider. Center uses this to tell an operator whether this exact
/// connection works, rather than reporting a healthy SerpApi fallback as a
/// successful SearXNG test.
pub(crate) async fn probe_searxng() -> Result<(), BackendError> {
    let base_url = key(SEARXNG_BASE_URL_VAR).ok_or(BackendError::NotConfigured)?;
    probe_searxng_at(&base_url).await
}

/// Healthy only when a broad-web engine answers. Blocked engines often return
/// an empty page rather than an error, so an answer from the last resort alone,
/// which sends real searches to SerpApi, is a failed test, not a green one.
async fn probe_searxng_at(base_url: &str) -> Result<(), BackendError> {
    let found = search_searxng(PROBE_QUERY, base_url, SEARCH_TIMEOUT).await?;
    if found.broad_web_answered {
        Ok(())
    } else {
        Err(BackendError::NoResult)
    }
}

/// Verify the configured SerpApi credential directly, even when SearXNG is the
/// deployment's preferred search path.
pub(crate) async fn probe_serpapi() -> Result<(), BackendError> {
    let api_key = key(SERPAPI_KEY_VAR).ok_or(BackendError::NotConfigured)?;
    search_serpapi("OpenAI", &api_key, SERPAPI_BASE_URL)
        .await
        .map(|_| ())
}

/// SearXNG remains the first and private path. If it cannot answer, an
/// explicitly configured SerpApi key provides continuity instead of turning a
/// transient engine block into an offline response on the Pin. That fallback
/// sends the query to SerpApi, so it is never enabled without the protected key.
async fn search_selected(
    query: &str,
    backend: SelectedBackend,
    fallback_serpapi_key: Option<&str>,
    serpapi_base_url: &str,
) -> Result<String, BackendError> {
    match backend {
        SelectedBackend::Searxng(base_url) => {
            match search_searxng(query, &base_url, SEARCH_TIMEOUT).await {
                Ok(result) if result.broad_web_answered => Ok(result.observation),
                Ok(result) => match fallback_serpapi_key {
                    Some(api_key) => {
                        tracing::warn!(
                            "SearXNG returned no broad-web engine results; trying SerpApi"
                        );
                        match search_serpapi(query, api_key, serpapi_base_url).await {
                            Ok(fallback) => Ok(fallback),
                            Err(error) => {
                                tracing::warn!(
                                    ?error,
                                    "SerpApi fallback failed; preserving the available SearXNG results"
                                );
                                Ok(result.observation)
                            }
                        }
                    }
                    None => Ok(result.observation),
                },
                Err(primary_error @ (BackendError::Unavailable | BackendError::NoResult)) => {
                    match fallback_serpapi_key {
                        Some(api_key) => {
                            tracing::warn!(
                                ?primary_error,
                                "SearXNG could not answer; trying SerpApi"
                            );
                            // A refused fallback key is logged. Search itself
                            // is still connected, and SearXNG's failure stands.
                            search_serpapi(query, api_key, serpapi_base_url)
                                .await
                                .map_err(|error| match error {
                                    BackendError::NotConfigured => primary_error,
                                    error => error,
                                })
                        }
                        None => Err(primary_error),
                    }
                }
                Err(error) => Err(error),
            }
        }
        SelectedBackend::SerpApi(api_key) => {
            search_serpapi(query, &api_key, serpapi_base_url).await
        }
    }
}

/// Whether the server-side search tool has a concrete backend.
pub(crate) fn configured() -> bool {
    selected_backend().is_some()
}

fn selected_backend() -> Option<SelectedBackend> {
    selected_backend_from(key(SEARXNG_BASE_URL_VAR), key(SERPAPI_KEY_VAR))
}

fn selected_backend_from(
    searxng_base_url: Option<String>,
    serpapi_key: Option<String>,
) -> Option<SelectedBackend> {
    if let Some(base_url) = searxng_base_url.filter(|value| !value.trim().is_empty()) {
        return Some(SelectedBackend::Searxng(base_url));
    }
    serpapi_key
        .filter(|value| !value.trim().is_empty())
        .map(SelectedBackend::SerpApi)
}

async fn search_serpapi(
    query: &str,
    api_key: &str,
    base_url: &str,
) -> Result<String, BackendError> {
    let mut url = reqwest::Url::parse(base_url).map_err(|_| BackendError::Unavailable)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(BackendError::Unavailable);
    }
    url.query_pairs_mut()
        .append_pair("engine", "google")
        .append_pair("q", query)
        .append_pair("api_key", api_key);
    // The key rides in the query, so neither the URL nor a reqwest error
    // (whose text includes it) is logged.
    let response = http()
        .get(url)
        .timeout(SEARCH_TIMEOUT)
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(refused("serpapi", status));
    }
    let found: SerpResponse = bounded_json(response).await?;
    serpapi_answer(&found, query)
}

/// What a SerpApi page says. SerpApi can answer 200 with an `error`: "Google
/// hasn't returned any results for this query." is an empty search, not an
/// outage. Any other (a spent plan, a rejected parameter) is an outage the
/// operator's log records.
fn serpapi_answer(found: &SerpResponse, query: &str) -> Result<String, BackendError> {
    match found.error.as_deref() {
        Some(error) if error.contains("hasn't returned any results") => Err(BackendError::NoResult),
        Some(_) => {
            tracing::warn!("SerpApi answered with an error");
            Err(BackendError::Unavailable)
        }
        None => summarize_serpapi(found, query).ok_or(BackendError::NoResult),
    }
}

async fn search_searxng(
    query: &str,
    base_url: &str,
    timeout: Duration,
) -> Result<SearxSearch, BackendError> {
    let url = searxng_url(base_url, query)?;
    let response = http()
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?;
    let found: SearxResponse = bounded_json(response).await?;
    let observation = summarize_searxng(&found, query).ok_or(BackendError::NoResult)?;
    let broad_web = |engine: &str| {
        BROAD_WEB_SEARXNG_ENGINES
            .iter()
            .any(|broad| engine.eq_ignore_ascii_case(broad))
    };
    Ok(SearxSearch {
        broad_web_answered: found.results.iter().any(|result| {
            broad_web(&result.engine) || result.engines.iter().any(|engine| broad_web(engine))
        }),
        observation,
    })
}

fn searxng_url(base_url: &str, query: &str) -> Result<reqwest::Url, BackendError> {
    let mut base = reqwest::Url::parse(base_url.trim()).map_err(|_| BackendError::Unavailable)?;
    if !matches!(base.scheme(), "http" | "https")
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err(BackendError::Unavailable);
    }

    let base_path = base.path().trim_end_matches('/');
    let search_path = if base_path.is_empty() {
        "/search".to_owned()
    } else {
        format!("{base_path}/search")
    };
    base.set_path(&search_path);
    base.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("format", "json")
        .append_pair("categories", "general")
        // SearXNG's `all` value is not a neutral market for every engine. The
        // production Bing adapter mapped it to unrelated locales, returning
        // Polish/Italian results for both English product names and Danish
        // questions. `en` preserves correct English ranking and still returns
        // Danish sources when the query itself is Danish.
        .append_pair("language", "en")
        .append_pair("safesearch", "1")
        .append_pair("pageno", "1");
    Ok(base)
}

async fn bounded_json<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, BackendError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(BackendError::Unavailable);
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| BackendError::Unavailable)?;
        if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(body.len()) {
            return Err(BackendError::Unavailable);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| BackendError::Unavailable)
}

/// Render a search response into transcript text.
///
/// Prefers the direct answer when the engine has one, then the knowledge-graph
/// description, then the top organic snippets. Nothing is synthesized: the text
/// is quoted source material with its provenance implied by the ordering, so the
/// model can answer from it without the server having decided the answer.
fn summarize_serpapi(found: &SerpResponse, query: &str) -> Option<String> {
    if let Some(ab) = &found.answer_box {
        for direct in [&ab.answer, &ab.snippet] {
            let direct = compact_text(direct, MAX_SNIPPET_BYTES);
            if !direct.is_empty() {
                return Some(format!("Search result for \"{query}\": {direct}"));
            }
        }
    }
    if let Some(kg) = &found.knowledge_graph {
        let description = compact_text(&kg.description, MAX_SNIPPET_BYTES);
        if !description.is_empty() {
            return Some(format!("Search result for \"{query}\": {description}"));
        }
    }

    summarize_results(
        found
            .organic_results
            .iter()
            .map(|result| (&*result.title, &*result.snippet)),
        query,
    )
}

fn summarize_searxng(found: &SearxResponse, query: &str) -> Option<String> {
    let query_terms = relevance_terms(query);
    let mut ranked: Vec<_> = found.results.iter().collect();
    ranked.sort_by_key(|result| std::cmp::Reverse(result_relevance(result, &query_terms)));
    summarize_results(
        ranked
            .iter()
            .map(|result| (&*result.title, &*result.content)),
        query,
    )
}

fn relevance_terms(text: &str) -> Vec<String> {
    const STOP_WORDS: &[&str] = &[
        "a", "about", "an", "and", "at", "for", "from", "how", "in", "is", "look", "me", "of",
        "on", "search", "tell", "the", "to", "up", "web", "what", "when", "where", "who",
    ];

    let mut terms: Vec<_> = text
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| term.chars().count() >= 3)
        .map(str::to_lowercase)
        .filter(|term| !STOP_WORDS.contains(&term.as_str()))
        .collect();
    terms.sort();
    terms.dedup();
    terms
}

fn result_relevance(result: &SearxResult, query_terms: &[String]) -> usize {
    let result_terms: std::collections::HashSet<_> = result
        .title
        .split(|character: char| !character.is_alphanumeric())
        .chain(
            result
                .content
                .split(|character: char| !character.is_alphanumeric()),
        )
        .filter(|term| term.chars().count() >= 3)
        .map(str::to_lowercase)
        .collect();
    query_terms
        .iter()
        .filter(|term| result_terms.contains(term.as_str()))
        .count()
}

fn summarize_results<'a>(
    results: impl Iterator<Item = (&'a str, &'a str)>,
    query: &str,
) -> Option<String> {
    let lines: Vec<String> = results
        .filter_map(|(title, snippet)| {
            let title = compact_text(title, MAX_TITLE_BYTES);
            let snippet = compact_text(snippet, MAX_SNIPPET_BYTES);
            match (title.is_empty(), snippet.is_empty()) {
                (true, true) => None,
                (false, true) => Some(format!("- {title}")),
                (true, false) => Some(format!("- {snippet}")),
                (false, false) => Some(format!("- {title}: {snippet}")),
            }
        })
        .take(MAX_RESULTS)
        .collect();
    if lines.is_empty() {
        return None;
    }
    Some(format!(
        "Search results for \"{query}\":\n{}",
        lines.join("\n")
    ))
}

fn bounded_query(query: &str) -> Option<String> {
    let compact = query.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        None
    } else {
        Some(compact_text(&compact, MAX_QUERY_BYTES))
    }
}

fn compact_text(input: &str, max_bytes: usize) -> String {
    let compact = input.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.len() <= max_bytes {
        return compact;
    }

    let ellipsis = '…';
    let mut end = max_bytes
        .saturating_sub(ellipsis.len_utf8())
        .min(compact.len());
    while end > 0 && !compact.is_char_boundary(end) {
        end -= 1;
    }
    let mut truncated = compact[..end].trim_end().to_owned();
    truncated.push(ellipsis);
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, extract::Query, http::StatusCode, routing::get};
    use std::collections::HashMap;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::net::TcpListener;

    // INFERRED adapter checks, with synthetic, unrecorded provider payloads.
    // Failure modes: wrong request parameters, blank featured answers hiding
    // organic hits, a degraded primary bypassing fallback, healthy primaries
    // wasting paid requests, rejected keys, and oversized response bodies.
    async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (format!("http://{address}"), task)
    }

    #[tokio::test]
    async fn serpapi_http_keeps_organic_results_when_featured_text_is_blank() {
        let router = Router::new().route(
            "/search.json",
            get(|Query(query): Query<HashMap<String, String>>| async move {
                assert_eq!(query["engine"], "google");
                assert_eq!(query["q"], "Luma & Pin");
                assert_eq!(query["api_key"], "synthetic-key");
                axum::Json(serde_json::json!({
                    "answer_box": {"answer": " \n", "snippet": " \t"},
                    "knowledge_graph": {"description": " \n"},
                    "organic_results": [{"title": "Luma", "snippet": "Pin setup guide"}]
                }))
            }),
        );
        let (base, task) = serve(router).await;
        let answer = search_serpapi(
            "Luma & Pin",
            "synthetic-key",
            &format!("{base}/search.json"),
        )
        .await
        .unwrap();
        assert!(answer.contains("Pin setup guide"));
        task.abort();
    }

    #[tokio::test]
    async fn searxng_http_checks_engine_health_and_uses_paid_fallback_only_when_needed() {
        let paid_requests = Arc::new(AtomicUsize::new(0));
        let counted_requests = paid_requests.clone();
        let router = Router::new()
            .route(
                "/search",
                get(|Query(query): Query<HashMap<String, String>>| async move {
                    assert_eq!(query["format"], "json");
                    assert_eq!(query["categories"], "general");
                    assert_eq!(query["language"], "en");
                    let engine = if query["q"] == "healthy" {
                        "bing"
                    } else {
                        "searchch"
                    };
                    axum::Json(serde_json::json!({"results": [{
                        "title": "Primary", "content": "Private search result", "engine": engine
                    }]}))
                }),
            )
            .route(
                "/search.json",
                get(move |Query(query): Query<HashMap<String, String>>| {
                    let counted_requests = counted_requests.clone();
                    async move {
                        counted_requests.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(query["q"], "degraded", "healthy search must stay private");
                        axum::Json(serde_json::json!({"organic_results": [{
                            "title": "Fallback", "snippet": "Paid search result"
                        }]}))
                    }
                }),
            );
        let (base, task) = serve(router).await;
        for (query, expected) in [
            ("healthy", "Private search result"),
            ("degraded", "Paid search result"),
        ] {
            let answer = search_selected(
                query,
                SelectedBackend::Searxng(base.clone()),
                Some("synthetic-key"),
                &format!("{base}/search.json"),
            )
            .await
            .unwrap();
            assert!(answer.contains(expected));
            assert_eq!(
                paid_requests.load(Ordering::SeqCst),
                usize::from(query == "degraded")
            );
        }
        assert_eq!(probe_searxng_at(&base).await, Err(BackendError::NoResult));
        task.abort();
    }

    #[tokio::test]
    async fn serpapi_http_rejects_bad_keys_and_oversized_responses() {
        let router = Router::new()
            .route("/refused", get(|| async { StatusCode::UNAUTHORIZED }))
            .route(
                "/oversized",
                get(|| async { "x".repeat(MAX_RESPONSE_BYTES + 1) }),
            );
        let (base, task) = serve(router).await;
        assert_eq!(
            search_serpapi("query", "synthetic-key", &format!("{base}/refused")).await,
            Err(BackendError::NotConfigured)
        );
        assert_eq!(
            search_serpapi("query", "synthetic-key", &format!("{base}/oversized")).await,
            Err(BackendError::Unavailable)
        );
        task.abort();
    }

    #[test]
    fn malformed_or_credentialed_base_urls_are_rejected() {
        for base_url in [
            "not a URL",
            "file:///etc/passwd",
            "http://user:password@searxng:8080",
            "http://searxng:8080?format=html",
        ] {
            assert!(searxng_url(base_url, "query").is_err(), "{base_url}");
        }
        let url = searxng_url("http://searxng:8080", "query").unwrap();
        assert_eq!(url.host_str(), Some("searxng"));
        assert_eq!(url.path(), "/search");
    }
}
