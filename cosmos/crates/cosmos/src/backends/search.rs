//! Web search — private SearXNG first, with the existing SerpApi adapter as a
//! protected availability fallback (`MODE_SERP_API` in carry's backend
//! enumeration).
//!
//! This backs the assistant's `web_search` tool. The result is folded into the
//! ReAct transcript as an **observation**, so it must be compact enough for a
//! model to reason over and honest about what it did and did not find.
//!
//! Evidence labels: **observed** — the device-facing tool surface identifies
//! web retrieval as `MODE_SERP_API`; **implemented** — SearXNG is this
//! deployment's private adapter for that surface; **unknown** — this does not
//! claim Humane operated SearXNG or used the same result-ranking policy.

use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, de::DeserializeOwned};

use super::{BackendError, http, key};

pub(crate) const SEARXNG_BASE_URL_VAR: &str = "CARRY_SEARXNG_BASE_URL";
const SERPAPI_KEY_VAR: &str = "CARRY_SERPAPI_KEY";
const SERPAPI_BASE_URL: &str = "https://serpapi.com/search.json";
const PRIMARY_SEARXNG_ENGINE: &str = "bing";

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
    primary_answered: bool,
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
                Ok(result) if result.primary_answered => Ok(result.observation),
                Ok(result) => match fallback_serpapi_key {
                    Some(api_key) => {
                        tracing::warn!(
                            primary_engine = PRIMARY_SEARXNG_ENGINE,
                            "SearXNG returned only degraded-engine results; trying SerpApi"
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
                            search_serpapi(query, api_key, serpapi_base_url).await
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
    if let Some(base_url) = key(SEARXNG_BASE_URL_VAR) {
        return Some(SelectedBackend::Searxng(base_url));
    }
    key(SERPAPI_KEY_VAR).map(SelectedBackend::SerpApi)
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
    let response = http()
        .get(url)
        .timeout(SEARCH_TIMEOUT)
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?;
    let found: SerpResponse = bounded_json(response).await?;

    if found.error.is_some() {
        return Err(BackendError::Unavailable);
    }
    summarize_serpapi(&found, query).ok_or(BackendError::NoResult)
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
    Ok(SearxSearch {
        primary_answered: found.results.iter().any(|result| {
            result.engine.eq_ignore_ascii_case(PRIMARY_SEARXNG_ENGINE)
                || result
                    .engines
                    .iter()
                    .any(|engine| engine.eq_ignore_ascii_case(PRIMARY_SEARXNG_ENGINE))
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
        let direct = if !ab.answer.is_empty() {
            &ab.answer
        } else {
            &ab.snippet
        };
        if !direct.is_empty() {
            let direct = compact_text(direct, MAX_SNIPPET_BYTES);
            return (!direct.is_empty())
                .then(|| format!("Search result for \"{query}\": {direct}"));
        }
    }
    if let Some(kg) = &found.knowledge_graph {
        if !kg.description.is_empty() {
            let description = compact_text(&kg.description, MAX_SNIPPET_BYTES);
            return (!description.is_empty())
                .then(|| format!("Search result for \"{query}\": {description}"));
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
    summarize_results(
        found
            .results
            .iter()
            .map(|result| (&*result.title, &*result.content)),
        query,
    )
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
    use std::sync::Arc;

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::{Mutex, oneshot},
    };

    static ENV_LOCK: Mutex<()> = Mutex::const_new(());

    struct TestEnv {
        previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl TestEnv {
        fn replace(values: &[(&'static str, Option<&str>)]) -> Self {
            let previous = values
                .iter()
                .map(|(name, _)| (*name, std::env::var_os(name)))
                .collect();
            for (name, value) in values {
                // SAFETY: all environment-mutating tests in this module hold
                // ENV_LOCK for their full lifetime.
                unsafe {
                    if let Some(value) = value {
                        std::env::set_var(name, value);
                    } else {
                        std::env::remove_var(name);
                    }
                }
            }
            Self { previous }
        }
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            for (name, value) in self.previous.drain(..) {
                // SAFETY: the owning test still holds ENV_LOCK while guards
                // drop, restoring the process environment before unlocking.
                unsafe {
                    if let Some(value) = value {
                        std::env::set_var(name, value);
                    } else {
                        std::env::remove_var(name);
                    }
                }
            }
        }
    }

    async fn serve_once(
        status: &'static str,
        body: String,
        delay: Duration,
    ) -> (String, oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = oneshot::channel();
        let body = Arc::new(body);
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 8192];
            let read = socket.read(&mut request).await.unwrap_or(0);
            let _ = request_tx.send(String::from_utf8_lossy(&request[..read]).into_owned());
            tokio::time::sleep(delay).await;
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = socket.write_all(response.as_bytes()).await;
        });
        (format!("http://{address}"), request_rx)
    }

    fn empty() -> SerpResponse {
        SerpResponse {
            error: None,
            answer_box: None,
            knowledge_graph: None,
            organic_results: Vec::new(),
        }
    }

    #[test]
    fn a_direct_answer_is_preferred_over_snippets() {
        let mut r = empty();
        r.answer_box = Some(AnswerBox {
            answer: "Paris".into(),
            snippet: String::new(),
        });
        r.organic_results = vec![Organic {
            title: "Paris".into(),
            snippet: "…".into(),
        }];
        let text = summarize_serpapi(&r, "capital of France").unwrap();
        assert!(text.contains("Paris"));
        assert!(!text.contains('-'), "the direct answer should stand alone");
    }

    #[test]
    fn falls_back_through_knowledge_graph_then_organic_results() {
        let mut kg = empty();
        kg.knowledge_graph = Some(KnowledgeGraph {
            description: "Paris is the capital of France.".into(),
        });
        assert!(
            summarize_serpapi(&kg, "q")
                .unwrap()
                .contains("capital of France")
        );

        let mut organic = empty();
        organic.organic_results = vec![
            Organic {
                title: "A".into(),
                snippet: "one".into(),
            },
            Organic {
                title: "B".into(),
                snippet: "two".into(),
            },
        ];
        let text = summarize_serpapi(&organic, "q").unwrap();
        assert!(text.contains("- A: one"));
        assert!(text.contains("- B: two"));
    }

    #[test]
    fn transcript_growth_is_bounded() {
        let mut r = empty();
        r.organic_results = (0..20)
            .map(|i| Organic {
                title: format!("t{i}"),
                snippet: "s".into(),
            })
            .collect();
        let text = summarize_serpapi(&r, "q").unwrap();
        assert_eq!(
            text.lines().count(),
            MAX_RESULTS + 1,
            "header + capped results"
        );
    }

    #[test]
    fn nothing_found_is_none_rather_than_an_empty_claim() {
        // Must not render "Search results for ...:" with nothing under it — the
        // model would read that as "searched, found nothing exists".
        assert!(summarize_serpapi(&empty(), "q").is_none());
    }

    #[tokio::test]
    async fn without_a_key_the_capability_reports_absent() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnv::replace(&[(SEARXNG_BASE_URL_VAR, None), (SERPAPI_KEY_VAR, None)]);
        assert_eq!(search("anything").await, Err(BackendError::NotConfigured));
    }

    #[tokio::test]
    async fn readiness_accepts_either_backend_but_not_blank_values() {
        let _lock = ENV_LOCK.lock().await;
        {
            let _env = TestEnv::replace(&[
                (SEARXNG_BASE_URL_VAR, Some("   ")),
                (SERPAPI_KEY_VAR, Some("")),
            ]);
            assert!(!configured());
        }
        {
            let _env = TestEnv::replace(&[
                (SEARXNG_BASE_URL_VAR, Some("http://searxng:8080")),
                (SERPAPI_KEY_VAR, None),
            ]);
            assert!(configured());
            assert!(matches!(
                selected_backend(),
                Some(SelectedBackend::Searxng(_))
            ));
        }
        {
            let _env = TestEnv::replace(&[
                (SEARXNG_BASE_URL_VAR, None),
                (SERPAPI_KEY_VAR, Some("synthetic-test-key")),
            ]);
            assert!(configured());
            assert!(matches!(
                selected_backend(),
                Some(SelectedBackend::SerpApi(_))
            ));
        }
    }

    #[tokio::test]
    async fn configured_searxng_is_selected_before_serpapi() {
        let _lock = ENV_LOCK.lock().await;
        let (base_url, request) = serve_once(
            "200 OK",
            r#"{"results":[{"title":"Local result","content":"From the private index","engine":"bing"}]}"#
                .to_owned(),
            Duration::ZERO,
        )
        .await;
        let _env = TestEnv::replace(&[
            (SEARXNG_BASE_URL_VAR, Some(&base_url)),
            (SERPAPI_KEY_VAR, Some("must-not-be-used")),
        ]);

        let result = search("private search").await.unwrap();
        assert!(result.contains("Local result"));
        let request = request.await.unwrap();
        assert!(request.starts_with("GET /search?"));
        assert!(request.contains("q=private+search"));
        assert!(request.contains("format=json"));
        assert!(request.contains("language=en"));
        assert!(!request.contains("language=all"));
    }

    #[tokio::test]
    async fn searxng_no_result_falls_back_to_configured_serpapi() {
        let (searxng_base_url, _) =
            serve_once("200 OK", r#"{"results":[]}"#.to_owned(), Duration::ZERO).await;
        let (serpapi_base_url, serpapi_request) = serve_once(
            "200 OK",
            r#"{"organic_results":[{"title":"Fallback result","snippet":"From SerpApi"}]}"#
                .to_owned(),
            Duration::ZERO,
        )
        .await;
        let serpapi_url = format!("{serpapi_base_url}/search.json");

        let result = search_selected(
            "fallback search",
            SelectedBackend::Searxng(searxng_base_url),
            Some("synthetic-test-key"),
            &serpapi_url,
        )
        .await
        .unwrap();

        assert!(result.contains("Fallback result"));
        let request = serpapi_request.await.unwrap();
        assert!(request.starts_with("GET /search.json?"));
        assert!(request.contains("engine=google"));
        assert!(request.contains("q=fallback+search"));
        assert!(request.contains("api_key=synthetic-test-key"));
    }

    #[tokio::test]
    async fn secondary_only_searxng_results_prefer_serpapi() {
        let (searxng_base_url, _) = serve_once(
            "200 OK",
            r#"{"results":[{"title":"Degraded result","content":"From a secondary engine","engine":"resulthunter"}]}"#
                .to_owned(),
            Duration::ZERO,
        )
        .await;
        let (serpapi_base_url, _) = serve_once(
            "200 OK",
            r#"{"organic_results":[{"title":"Fallback result","snippet":"From SerpApi"}]}"#
                .to_owned(),
            Duration::ZERO,
        )
        .await;

        let result = search_selected(
            "fallback search",
            SelectedBackend::Searxng(searxng_base_url),
            Some("synthetic-test-key"),
            &format!("{serpapi_base_url}/search.json"),
        )
        .await
        .unwrap();

        assert!(result.contains("Fallback result"));
        assert!(!result.contains("Degraded result"));
    }

    #[tokio::test]
    async fn secondary_results_survive_a_failed_serpapi_fallback() {
        let (searxng_base_url, _) = serve_once(
            "200 OK",
            r#"{"results":[{"title":"Degraded result","content":"Still useful","engines":["resulthunter"]}]}"#
                .to_owned(),
            Duration::ZERO,
        )
        .await;
        let (serpapi_base_url, _) =
            serve_once("503 Service Unavailable", "{}".to_owned(), Duration::ZERO).await;

        let result = search_selected(
            "fallback search",
            SelectedBackend::Searxng(searxng_base_url),
            Some("synthetic-test-key"),
            &format!("{serpapi_base_url}/search.json"),
        )
        .await
        .unwrap();

        assert!(result.contains("Degraded result"));
    }

    #[tokio::test]
    async fn merged_primary_engine_result_does_not_call_serpapi() {
        let (searxng_base_url, _) = serve_once(
            "200 OK",
            r#"{"results":[{"title":"Primary result","content":"From Bing","engine":"resulthunter","engines":["resulthunter","bing"]}]}"#
                .to_owned(),
            Duration::ZERO,
        )
        .await;

        let result = search_selected(
            "primary search",
            SelectedBackend::Searxng(searxng_base_url),
            Some("must-not-be-used"),
            "http://127.0.0.1:1/search.json",
        )
        .await
        .unwrap();

        assert!(result.contains("Primary result"));
    }

    #[tokio::test]
    async fn searxng_unavailable_falls_back_to_configured_serpapi() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let searxng_base_url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let (serpapi_base_url, _) = serve_once(
            "200 OK",
            r#"{"answer_box":{"answer":"Fallback answer","snippet":""}}"#.to_owned(),
            Duration::ZERO,
        )
        .await;
        let serpapi_url = format!("{serpapi_base_url}/search.json");

        let result = search_selected(
            "query",
            SelectedBackend::Searxng(searxng_base_url),
            Some("synthetic-test-key"),
            &serpapi_url,
        )
        .await
        .unwrap();
        assert!(result.contains("Fallback answer"));
    }

    #[tokio::test]
    async fn searxng_error_stays_visible_without_a_fallback_key() {
        let (base_url, _) =
            serve_once("200 OK", r#"{"results":[]}"#.to_owned(), Duration::ZERO).await;
        let result = search_selected(
            "query",
            SelectedBackend::Searxng(base_url),
            None,
            SERPAPI_BASE_URL,
        )
        .await;
        assert_eq!(result, Err(BackendError::NoResult));
    }

    #[tokio::test]
    async fn malformed_searxng_json_is_unavailable() {
        let (base_url, _) = serve_once("200 OK", "not-json".to_owned(), Duration::ZERO).await;
        assert_eq!(
            search_searxng("query", &base_url, Duration::from_secs(1)).await,
            Err(BackendError::Unavailable)
        );
    }

    #[tokio::test]
    async fn empty_searxng_results_are_no_result() {
        let (base_url, _) =
            serve_once("200 OK", r#"{"results":[]}"#.to_owned(), Duration::ZERO).await;
        assert_eq!(
            search_searxng("query", &base_url, Duration::from_secs(1)).await,
            Err(BackendError::NoResult)
        );
    }

    #[tokio::test]
    async fn searxng_request_timeout_is_bounded() {
        let (base_url, _) = serve_once(
            "200 OK",
            r#"{"results":[]}"#.to_owned(),
            Duration::from_millis(200),
        )
        .await;
        let started = std::time::Instant::now();
        assert_eq!(
            search_searxng("query", &base_url, Duration::from_millis(20)).await,
            Err(BackendError::Unavailable)
        );
        assert!(started.elapsed() < Duration::from_millis(150));
    }

    #[tokio::test]
    async fn oversized_searxng_response_is_rejected_before_json_decode() {
        let body = format!(
            r#"{{"results":[],"padding":"{}"}}"#,
            "x".repeat(MAX_RESPONSE_BYTES)
        );
        let (base_url, _) = serve_once("200 OK", body, Duration::ZERO).await;
        assert_eq!(
            search_searxng("query", &base_url, Duration::from_secs(1)).await,
            Err(BackendError::Unavailable)
        );
    }

    #[test]
    fn queries_and_result_fields_are_utf8_safe_and_bounded() {
        let query = format!("  {}  ", "💡".repeat(MAX_QUERY_BYTES));
        let bounded = bounded_query(&query).unwrap();
        assert!(bounded.len() <= MAX_QUERY_BYTES);
        assert!(bounded.ends_with('…'));

        let response = SearxResponse {
            results: (0..20)
                .map(|index| SearxResult {
                    title: format!("{index} {}", "t".repeat(MAX_TITLE_BYTES * 2)),
                    content: "s".repeat(MAX_SNIPPET_BYTES * 2),
                    engine: "bing".to_owned(),
                    engines: Vec::new(),
                })
                .collect(),
        };
        let text = summarize_searxng(&response, &bounded).unwrap();
        assert_eq!(text.lines().count(), MAX_RESULTS + 1);
        assert!(
            text.len()
                <= MAX_QUERY_BYTES + MAX_RESULTS * (MAX_TITLE_BYTES + MAX_SNIPPET_BYTES + 8) + 64
        );
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
