//! Web search — private SearXNG first, with the existing SerpApi adapter as a
//! protected availability fallback (`MODE_SERP_API` in cosmos's backend
//! enumeration).
//!
//! This backs the assistant's `web_search` tool. The result is folded into the
//! ReAct transcript as an **observation**, so it must be compact enough for a
//! model to reason over and honest about what it did and did not find.
//!
//! Ambiance uses `prepare_lookup` after selecting an explicitly approved provider.
//! That separate entry preserves real citations and never uses this legacy
//! observation path's provider fallback.
//!
//! Evidence labels: **observed** — the device-facing tool surface identifies
//! web retrieval as `MODE_SERP_API`; **implemented** — SearXNG is this
//! deployment's private adapter for that surface; **unknown** — this does not
//! claim Humane operated SearXNG or used the same result-ranking policy.

use std::{collections::BTreeSet, time::Duration};

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use super::lookup::{
    LookupError, LookupProvider, LookupProviderIdentity, LookupQuery, MAX_LOOKUP_URL_BYTES,
    MAX_QUERY_BYTES, bounded_body, get_payload_digest, lookup_endpoint, lookup_http,
    lookup_response_privacy,
};
use super::{BackendError, http, key};

pub(crate) const SEARXNG_BASE_URL_VAR: &str = "COSMOS_SEARXNG_BASE_URL";
const SERPAPI_KEY_VAR: &str = "COSMOS_SERPAPI_KEY";
const SERPAPI_BASE_URL: &str = "https://serpapi.com/search.json";
const PRIMARY_SEARXNG_ENGINE: &str = "bing";

/// SearXNG is on the private service network, so it should fail quickly enough
/// for the assistant to give an honest unavailable observation in the same
/// turn. The shared client retains its stricter four-second connect bound.
const SEARCH_TIMEOUT: Duration = Duration::from_secs(5);

const MAX_TITLE_BYTES: usize = 192;
const MAX_SNIPPET_BYTES: usize = 640;

/// How many organic results to summarize into the observation. The transcript
/// rides in the model's context on every subsequent step of the run, so this is
/// deliberately small.
const MAX_RESULTS: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LookupSource {
    pub title: String,
    pub snippet: String,
    pub url: String,
}

/// Source text is untrusted data. Runtime supplies the lookup ID, receipt time,
/// privacy join and evidence digest; the provider cannot assign those values.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupEvidence {
    pub sources: Vec<LookupSource>,
    pub privacy_floor: crate::ambiance::PrivacyClass,
}

/// One exact request snapshot. It contains a credential-bearing URL and must
/// never implement Debug/Serialize/Clone. Preparing it performs no network I/O;
/// the runtime must commit its disclosure before polling consuming execute().
pub struct PreparedLookup {
    identity: LookupProviderIdentity,
    query: LookupQuery,
    query_digest: String,
    payload_digest: String,
    url: reqwest::Url,
}

impl PreparedLookup {
    pub fn identity(&self) -> &LookupProviderIdentity {
        &self.identity
    }

    pub fn query(&self) -> &str {
        self.query.as_str()
    }

    pub fn query_digest(&self) -> &str {
        &self.query_digest
    }

    /// Digest of the exact GET method, URL and Accept header before adding
    /// authentication. Credentials never enter public identity or ledger hashes.
    pub fn payload_digest(&self) -> &str {
        &self.payload_digest
    }

    pub async fn execute(self) -> Result<LookupEvidence, LookupError> {
        let response = lookup_http()?
            .get(self.url)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| LookupError::Unavailable)?;
        // error_for_status() accepts redirects; those are not usable answers.
        if !response.status().is_success() {
            return Err(LookupError::Unavailable);
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next());
        if !content_type.is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
        {
            return Err(LookupError::Malformed);
        }
        let body = bounded_body(response).await?;
        // This join precedes DTO parsing and every row/field reduction. Content
        // discarded by projection still contributed to this service response.
        let privacy_floor = lookup_response_privacy(&body)?;
        let sources = match self.identity.provider {
            LookupProvider::Searxng => {
                let found: LookupSearxResponse =
                    serde_json::from_slice(&body).map_err(|_| LookupError::Malformed)?;
                if found.error.is_some() {
                    return Err(LookupError::Unavailable);
                }
                let results = found.results.ok_or(LookupError::Malformed)?;
                if results.is_empty()
                    && found
                        .unresponsive_engines
                        .is_some_and(|engines| !engines.is_empty())
                {
                    return Err(LookupError::Unavailable);
                }
                let terms = relevance_terms(self.query.as_str());
                let mut ranked: Vec<_> = results.iter().collect();
                ranked.sort_by_key(|result| std::cmp::Reverse(result_relevance(result, &terms)));
                lookup_sources(ranked.into_iter().map(|row| {
                    (
                        &*row.title,
                        &*row.content,
                        row.url.as_str().unwrap_or_default(),
                    )
                }))
            }
            LookupProvider::SerpApi => {
                let found: LookupSerpResponse =
                    serde_json::from_slice(&body).map_err(|_| LookupError::Malformed)?;
                if found.error.is_some() {
                    return Err(LookupError::Unavailable);
                }
                // Direct answers without an actual source link cannot become
                // cited evidence. The legacy observation path stays unchanged.
                let results = found.organic_results.ok_or(LookupError::Malformed)?;
                lookup_sources(results.iter().map(|row| {
                    (
                        &*row.title,
                        &*row.snippet,
                        row.link.as_str().unwrap_or_default(),
                    )
                }))
            }
            LookupProvider::GooglePlaces => return Err(LookupError::InvalidProvider),
        };
        let sources = match sources {
            Ok(sources) => sources,
            Err(LookupError::NoResult) => Vec::new(),
            Err(error) => return Err(error),
        };
        Ok(LookupEvidence {
            sources,
            privacy_floor,
        })
    }
}

/// At most two server-derived candidates. Selecting one in owner policy never
/// enables the other one, even when both providers have configuration.
pub fn lookup_providers() -> Vec<LookupProviderIdentity> {
    let config = crate::integrations::active().snapshot().search;
    lookup_providers_from(&config, SERPAPI_BASE_URL)
}

pub fn prepare_lookup(
    identity: &LookupProviderIdentity,
    query: LookupQuery,
) -> Result<PreparedLookup, LookupError> {
    let config = crate::integrations::active().snapshot().search;
    prepare_lookup_from(identity, query, &config, SERPAPI_BASE_URL)
}

/// Deterministic integration fixtures use an isolated configuration snapshot,
/// never the installed provider authority or a process environment mutation.
#[cfg(test)]
pub(crate) fn lookup_providers_for_test(
    config: &crate::integrations::SearchConfig,
) -> Vec<LookupProviderIdentity> {
    lookup_providers_from(config, SERPAPI_BASE_URL)
}

#[cfg(test)]
pub(crate) fn prepare_lookup_for_test(
    identity: &LookupProviderIdentity,
    query: LookupQuery,
    config: &crate::integrations::SearchConfig,
) -> Result<PreparedLookup, LookupError> {
    prepare_lookup_from(identity, query, config, SERPAPI_BASE_URL)
}

fn lookup_providers_from(
    config: &crate::integrations::SearchConfig,
    serpapi_endpoint: &str,
) -> Vec<LookupProviderIdentity> {
    [LookupProvider::Searxng, LookupProvider::SerpApi]
        .into_iter()
        .filter_map(|provider| configured_lookup_identity(provider, config, serpapi_endpoint).ok())
        .collect()
}

fn configured_lookup_identity(
    provider: LookupProvider,
    config: &crate::integrations::SearchConfig,
    serpapi_endpoint: &str,
) -> Result<LookupProviderIdentity, LookupError> {
    let endpoint = match provider {
        LookupProvider::Searxng => {
            let base = config
                .searxng_base_url
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(LookupError::NotConfigured)?;
            if base.chars().any(char::is_whitespace) || base.contains('\\') {
                return Err(LookupError::InvalidProvider);
            }
            let mut url = searxng_url(base, "").map_err(|_| LookupError::InvalidProvider)?;
            url.set_query(None);
            url.to_string()
        }
        LookupProvider::SerpApi => {
            config
                .serpapi_key
                .as_deref()
                .filter(|key| !key.trim().is_empty())
                .ok_or(LookupError::NotConfigured)?;
            serpapi_endpoint.to_owned()
        }
        LookupProvider::GooglePlaces => return Err(LookupError::InvalidProvider),
    };
    lookup_endpoint(&endpoint)?;
    Ok(LookupProviderIdentity {
        provider,
        configuration_digest: lookup_configuration_digest(provider, &endpoint)
            .ok_or(LookupError::InvalidProvider)?,
        endpoint,
    })
}

fn prepare_lookup_from(
    identity: &LookupProviderIdentity,
    query: LookupQuery,
    config: &crate::integrations::SearchConfig,
    serpapi_endpoint: &str,
) -> Result<PreparedLookup, LookupError> {
    if !identity.valid() {
        return Err(LookupError::InvalidProvider);
    }
    let configured = configured_lookup_identity(identity.provider, config, serpapi_endpoint)?;
    if &configured != identity {
        return Err(LookupError::StaleProvider);
    }
    let mut url = lookup_endpoint(&identity.endpoint)?;
    {
        let mut parameters = url.query_pairs_mut();
        parameters.append_pair("q", query.as_str());
        for &(name, value) in
            lookup_parameters(identity.provider).ok_or(LookupError::InvalidProvider)?
        {
            parameters.append_pair(name, value);
        }
    }
    let query_digest = crate::surface_registry::hash(query.as_str().as_bytes());
    let payload_digest = get_payload_digest(&url);
    if identity.provider == LookupProvider::SerpApi {
        let key = config
            .serpapi_key
            .as_deref()
            .ok_or(LookupError::NotConfigured)?;
        url.query_pairs_mut().append_pair("api_key", key);
    }
    Ok(PreparedLookup {
        identity: configured,
        query,
        query_digest,
        payload_digest,
        url,
    })
}

fn lookup_parameters(provider: LookupProvider) -> Option<&'static [(&'static str, &'static str)]> {
    match provider {
        LookupProvider::Searxng => Some(&[
            ("format", "json"),
            ("categories", "general"),
            ("language", "en"),
            ("safesearch", "1"),
            ("pageno", "1"),
            ("engines", "bing"),
        ]),
        LookupProvider::SerpApi => Some(&[("engine", "google")]),
        LookupProvider::GooglePlaces => None,
    }
}

pub(super) fn lookup_configuration_digest(
    provider: LookupProvider,
    endpoint: &str,
) -> Option<String> {
    // Array order is fixed even if another dependency enables serde_json's
    // preserve_order feature. No credential or mutable provider response enters it.
    let profile = serde_json::json!([
        "cosmos.web-lookup",
        1,
        provider,
        endpoint,
        lookup_parameters(provider)?,
    ]);
    Some(crate::surface_registry::hash(
        profile.to_string().as_bytes(),
    ))
}

fn lookup_sources<'a>(
    rows: impl Iterator<Item = (&'a str, &'a str, &'a str)>,
) -> Result<Vec<LookupSource>, LookupError> {
    let mut sources = Vec::new();
    let mut seen = BTreeSet::new();
    let mut had_rows = false;
    for (title, snippet, source_url) in rows {
        had_rows = true;
        if source_url.len() > MAX_LOOKUP_URL_BYTES
            || source_url
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
            || source_url.contains('\\')
        {
            continue;
        }
        let Ok(url) = reqwest::Url::parse(source_url) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.as_str().len() > MAX_LOOKUP_URL_BYTES
        {
            continue;
        }
        let title = compact_text(title, MAX_TITLE_BYTES);
        let snippet = compact_text(snippet, MAX_SNIPPET_BYTES);
        if (title.is_empty() && snippet.is_empty()) || !seen.insert(url.to_string()) {
            continue;
        }
        sources.push(LookupSource {
            title,
            snippet,
            url: url.to_string(),
        });
        if sources.len() == MAX_RESULTS {
            break;
        }
    }
    if sources.is_empty() {
        return Err(if had_rows {
            LookupError::Malformed
        } else {
            LookupError::NoResult
        });
    }
    Ok(sources)
}

enum SelectedBackend {
    Searxng(String),
    SerpApi(String),
}

// Unlike the legacy observation DTOs, a missing result field is not an empty
// result. Provider errors and an unavailable selected engine remain failures.
#[derive(Deserialize)]
struct LookupSearxResponse {
    results: Option<Vec<SearxResult>>,
    error: Option<serde_json::Value>,
    unresponsive_engines: Option<Vec<serde_json::Value>>,
}

#[derive(Deserialize)]
struct LookupSerpResponse {
    organic_results: Option<Vec<Organic>>,
    error: Option<serde_json::Value>,
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
    #[serde(default)]
    link: serde_json::Value,
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
    #[serde(default)]
    url: serde_json::Value,
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

/// Verify the configured private SearXNG endpoint without falling back to a
/// different provider. Center uses this to tell an operator whether this exact
/// connection works, rather than reporting a healthy SerpApi fallback as a
/// successful SearXNG test.
pub(crate) async fn probe_searxng() -> Result<(), BackendError> {
    let base_url = key(SEARXNG_BASE_URL_VAR).ok_or(BackendError::NotConfigured)?;
    search_searxng("OpenAI", &base_url, SEARCH_TIMEOUT)
        .await
        .map(|_| ())
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
    lookup_json(response)
        .await
        .map_err(|_| BackendError::Unavailable)
}

async fn lookup_json<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, LookupError> {
    let body = bounded_body(response).await?;
    serde_json::from_slice(&body).map_err(|_| LookupError::Malformed)
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
    use crate::backends::lookup::MAX_RESPONSE_BYTES;
    use std::sync::Arc;

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::oneshot,
    };

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
            link: serde_json::Value::Null,
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
                link: serde_json::Value::Null,
            },
            Organic {
                title: "B".into(),
                snippet: "two".into(),
                link: serde_json::Value::Null,
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
                link: serde_json::Value::Null,
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

    #[test]
    fn without_a_key_the_capability_reports_absent() {
        assert!(selected_backend_from(None, None).is_none());
    }

    #[test]
    fn readiness_accepts_either_backend_but_not_blank_values() {
        assert!(selected_backend_from(Some("   ".to_owned()), Some(String::new())).is_none());
        assert!(matches!(
            selected_backend_from(Some("http://searxng:8080".to_owned()), None),
            Some(SelectedBackend::Searxng(_))
        ));
        assert!(matches!(
            selected_backend_from(None, Some("synthetic-test-key".to_owned())),
            Some(SelectedBackend::SerpApi(_))
        ));
    }

    #[tokio::test]
    async fn configured_searxng_is_selected_before_serpapi() {
        let (base_url, request) = serve_once(
            "200 OK",
            r#"{"results":[{"title":"Local result","content":"From the private index","engine":"bing"}]}"#
                .to_owned(),
            Duration::ZERO,
        )
        .await;
        let backend = selected_backend_from(Some(base_url), Some("must-not-be-used".to_owned()))
            .expect("one configured search backend");
        assert!(matches!(backend, SelectedBackend::Searxng(_)));

        let result = search_selected(
            "private search",
            backend,
            Some("must-not-be-used"),
            SERPAPI_BASE_URL,
        )
        .await
        .unwrap();
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
                    url: serde_json::Value::Null,
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
    fn searxng_promotes_query_relevant_results_before_truncation() {
        let response = SearxResponse {
            results: [
                ("Punch newspapers", "Breaking news from Nigeria", "bing"),
                ("The Nation", "Latest Nigerian headlines", "bing"),
                ("CNN", "World news", "bing"),
                ("NDTV", "Latest news from India", "bing"),
                (
                    "Denmark | The Guardian",
                    "Latest news and features from Denmark",
                    "yandex",
                ),
            ]
            .into_iter()
            .map(|(title, content, engine)| SearxResult {
                title: title.to_owned(),
                content: content.to_owned(),
                engine: engine.to_owned(),
                engines: Vec::new(),
                url: serde_json::Value::Null,
            })
            .collect(),
        };

        let text = summarize_searxng(&response, "latest news in Denmark").unwrap();
        assert!(text.contains("Denmark | The Guardian"));
        assert_eq!(text.lines().count(), MAX_RESULTS + 1);
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

    fn lookup_config(searxng_base_url: Option<String>) -> crate::integrations::SearchConfig {
        crate::integrations::SearchConfig {
            searxng_base_url,
            serpapi_key: Some("synthetic-lookup-key".into()),
            ..Default::default()
        }
    }

    #[test]
    fn ambiance_lookup_query_rejects_changes_that_would_silently_truncate_the_disclosure() {
        assert_eq!(
            LookupQuery::new("  latest\n Danish\tnews ")
                .unwrap()
                .as_str(),
            "latest Danish news"
        );
        assert_eq!(LookupQuery::new(" ").err(), Some(LookupError::InvalidQuery));
        assert_eq!(
            LookupQuery::new("a\0b").err(),
            Some(LookupError::InvalidQuery)
        );
        assert_eq!(
            LookupQuery::new(&"a".repeat(513)).err(),
            Some(LookupError::InvalidQuery)
        );
        assert_eq!(
            LookupQuery::new(&"💡".repeat(129)).err(),
            Some(LookupError::InvalidQuery)
        );
        assert_eq!(
            LookupQuery::new(&"💡".repeat(128)).unwrap().as_str().len(),
            512
        );
    }

    #[test]
    fn ambiance_lookup_identity_is_canonical_profile_bound_and_credential_free() {
        let config = lookup_config(Some("https://search.example/personal".into()));
        let providers = lookup_providers_from(&config, SERPAPI_BASE_URL);
        assert_eq!(providers.len(), 2);
        assert_eq!(
            providers[0].endpoint,
            "https://search.example/personal/search"
        );
        assert_eq!(providers[1].endpoint, "https://serpapi.com/search.json");
        for provider in &providers {
            assert!(provider.valid());
            let serialized = serde_json::to_value(provider).unwrap();
            assert_eq!(serialized.as_object().unwrap().len(), 3);
            assert!(serialized.get("configurationDigest").is_some());
            assert!(!serialized.to_string().contains("synthetic-lookup-key"));
        }
        assert_eq!(
            serde_json::to_value(providers[1].provider).unwrap(),
            "serp_api"
        );
        let mut changed = providers[0].clone();
        changed.endpoint = "https://different.example/search".into();
        assert!(
            !changed.valid(),
            "changing destination invalidates the fixed profile digest"
        );
        changed = providers[0].clone();
        changed.configuration_digest = "a".repeat(64);
        assert!(!changed.valid());
        let mut rotated = config.clone();
        rotated.serpapi_key = Some("a-different-synthetic-key".into());
        assert_eq!(providers, lookup_providers_from(&rotated, SERPAPI_BASE_URL));
        for endpoint in [
            "https://search.example/search?",
            "https://search.example/search#",
            "https://user:password@search.example/search",
            "https://SEARCH.example/search",
            "https://search.example/white space",
            "https:\\search.example/search",
            "file:///tmp/search",
            "https://search.example",
        ] {
            assert!(
                lookup_endpoint(endpoint).is_err(),
                "noncanonical/unsafe endpoint: {endpoint}"
            );
        }
        assert!(lookup_endpoint(&format!("https://search.example/{}", "x".repeat(1024))).is_err());
    }

    #[tokio::test]
    async fn ambiance_lookup_stale_configuration_is_rejected_without_contacting_either_endpoint() {
        let first = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let old = lookup_config(Some(format!("http://{}", first.local_addr().unwrap())));
        let changed = lookup_config(Some(format!("http://{}", second.local_addr().unwrap())));
        let provider = lookup_providers_from(&old, SERPAPI_BASE_URL).remove(0);
        assert_eq!(
            prepare_lookup_from(
                &provider,
                LookupQuery::new("query").unwrap(),
                &changed,
                SERPAPI_BASE_URL
            )
            .err(),
            Some(LookupError::StaleProvider)
        );
        let absent = lookup_config(None);
        assert_eq!(
            prepare_lookup_from(
                &provider,
                LookupQuery::new("query").unwrap(),
                &absent,
                SERPAPI_BASE_URL
            )
            .err(),
            Some(LookupError::NotConfigured)
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(30), first.accept())
                .await
                .is_err()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(30), second.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn ambiance_lookup_uses_one_selected_provider_with_exact_query_profile_and_real_sources()
    {
        let (base, request) = serve_once("200 OK", r#"{"results":[{"title":"Actual article","content":"Actual source text","url":"https://example.org/article?id=7#part","engine":"bing"}]}"#.into(), Duration::ZERO).await;
        let config = lookup_config(Some(base));
        let provider = lookup_providers_from(&config, SERPAPI_BASE_URL).remove(0);
        let prepared = prepare_lookup_from(
            &provider,
            LookupQuery::new("  Danish \nnews ").unwrap(),
            &config,
            SERPAPI_BASE_URL,
        )
        .unwrap();
        let query_digest = prepared.query_digest().to_owned();
        let payload_digest = prepared.payload_digest().to_owned();
        assert_eq!(prepared.identity(), &provider);
        assert_eq!(prepared.query(), "Danish news");
        let evidence = prepared.execute().await.unwrap();
        assert_eq!(
            evidence.sources,
            [LookupSource {
                title: "Actual article".into(),
                snippet: "Actual source text".into(),
                url: "https://example.org/article?id=7#part".into(),
            }]
        );
        let request = request.await.unwrap();
        let target = request
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap();
        let actual = reqwest::Url::parse(&provider.endpoint)
            .unwrap()
            .join(target)
            .unwrap();
        let parameters: std::collections::BTreeMap<_, _> =
            actual.query_pairs().into_owned().collect();
        assert_eq!(parameters.get("q").map(String::as_str), Some("Danish news"));
        assert_eq!(parameters.get("engines").map(String::as_str), Some("bing"));
        assert_eq!(parameters.get("format").map(String::as_str), Some("json"));
        assert_eq!(parameters.get("language").map(String::as_str), Some("en"));
        assert_eq!(parameters.len(), 7);
        assert!(!request.contains("api_key"));
        assert_eq!(query_digest, crate::surface_registry::hash(b"Danish news"));
        assert_eq!(
            payload_digest,
            crate::surface_registry::hash(
                format!("GET\n{actual}\naccept:application/json\n").as_bytes()
            )
        );
    }

    #[tokio::test]
    async fn ambiance_lookup_serpapi_snapshot_authentication_never_enters_public_digests() {
        let (base, request) = serve_once("200 OK", r#"{"organic_results":[{"title":"Found","snippet":"Evidence","link":"https://example.org/found"}]}"#.into(), Duration::ZERO).await;
        let endpoint = format!("{base}/search.json");
        let config = lookup_config(None);
        let provider = lookup_providers_from(&config, &endpoint).remove(0);
        let prepared = prepare_lookup_from(
            &provider,
            LookupQuery::new("actual query").unwrap(),
            &config,
            &endpoint,
        )
        .unwrap();
        let public_digest = prepared.payload_digest().to_owned();
        let mut rotated = config.clone();
        rotated.serpapi_key = Some("rotated-synthetic-key".into());
        let other = prepare_lookup_from(
            &provider,
            LookupQuery::new("actual query").unwrap(),
            &rotated,
            &endpoint,
        )
        .unwrap();
        assert_eq!(other.payload_digest(), public_digest);
        assert_eq!(other.query_digest(), prepared.query_digest());
        let evidence = prepared.execute().await.unwrap();
        assert_eq!(evidence.sources[0].url, "https://example.org/found");
        let request = request.await.unwrap();
        assert!(request.contains("engine=google"));
        assert!(request.contains("q=actual+query"));
        assert!(request.contains("api_key=synthetic-lookup-key"));
        assert!(!request.contains("rotated-synthetic-key"));
    }

    #[tokio::test]
    async fn ambiance_lookup_empty_failed_or_degraded_searxng_never_calls_the_other_configured_provider()
     {
        let fallback = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/search.json", fallback.local_addr().unwrap());
        for (status, body, expected) in [
            ("200 OK", r#"{"results":[]}"#, None),
            (
                "503 Service Unavailable",
                "{}",
                Some(LookupError::Unavailable),
            ),
            (
                "200 OK",
                r#"{"results":[{"title":"Available","content":"Secondary source","url":"https://example.org/available","engine":"secondary"}]}"#,
                None,
            ),
        ] {
            let (base, request) = serve_once(status, body.into(), Duration::ZERO).await;
            let config = lookup_config(Some(base));
            let provider = lookup_providers_from(&config, &endpoint).remove(0);
            let prepared = prepare_lookup_from(
                &provider,
                LookupQuery::new("only approved provider").unwrap(),
                &config,
                &endpoint,
            )
            .unwrap();
            assert_eq!(prepared.execute().await.err(), expected);
            assert!(request.await.unwrap().contains("engines=bing"));
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), fallback.accept())
                .await
                .is_err(),
            "fallback received a connection"
        );
    }

    #[tokio::test]
    async fn ambiance_lookup_redirects_never_disclose_to_a_second_endpoint() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_url = format!(
            "http://{}/must-not-receive-query",
            target.local_addr().unwrap()
        );
        let mut source_calls = 0;
        for provider in [LookupProvider::Searxng, LookupProvider::SerpApi] {
            for status in [301, 302, 303, 307, 308] {
                let source = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let base = format!("http://{}", source.local_addr().unwrap());
                let location = target_url.clone();
                let handle = tokio::spawn(async move {
                    let (mut socket, _) = source.accept().await.unwrap();
                    let mut request = vec![0; 8192];
                    let count = socket.read(&mut request).await.unwrap();
                    assert!(
                        String::from_utf8_lossy(&request[..count]).contains("q=bounded+lookup")
                    );
                    socket.write_all(format!("HTTP/1.1 {status} Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                });
                let config = lookup_config(Some(base.clone()));
                let serpapi_endpoint = format!("{base}/search.json");
                let identity = lookup_providers_from(&config, &serpapi_endpoint)
                    .into_iter()
                    .find(|identity| identity.provider == provider)
                    .unwrap();
                let prepared = prepare_lookup_from(
                    &identity,
                    LookupQuery::new("bounded lookup").unwrap(),
                    &config,
                    &serpapi_endpoint,
                )
                .unwrap();
                assert_eq!(prepared.execute().await, Err(LookupError::Unavailable));
                handle.await.unwrap();
                source_calls += 1;
            }
        }
        assert_eq!(source_calls, 10);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), target.accept())
                .await
                .is_err(),
            "redirect target received a connection"
        );
    }

    #[tokio::test]
    async fn ambiance_lookup_malformed_oversized_and_uncited_results_are_distinct_from_no_result() {
        for (body, expected) in [
            ("not-json".to_owned(), LookupError::Malformed),
            ("{}".to_owned(), LookupError::Malformed),
            (
                r#"{"error":"provider failed"}"#.to_owned(),
                LookupError::Unavailable,
            ),
            (
                r#"{"results":[],"unresponsive_engines":[["bing","timeout"]]}"#.to_owned(),
                LookupError::Unavailable,
            ),
            (
                format!(
                    r#"{{"results":[],"padding":"{}"}}"#,
                    "x".repeat(MAX_RESPONSE_BYTES)
                ),
                LookupError::Oversized,
            ),
            (
                r#"{"results":[{"title":"No source URL","content":"Cannot cite this"}]}"#
                    .to_owned(),
                LookupError::Malformed,
            ),
            (
                r#"{"results":[],"ignored":"\uZZZZ"}"#.to_owned(),
                LookupError::Malformed,
            ),
        ] {
            let (base, _) = serve_once("200 OK", body, Duration::ZERO).await;
            let config = lookup_config(Some(base));
            let identity = lookup_providers_from(&config, SERPAPI_BASE_URL).remove(0);
            let prepared = prepare_lookup_from(
                &identity,
                LookupQuery::new("lookup").unwrap(),
                &config,
                SERPAPI_BASE_URL,
            )
            .unwrap();
            assert_eq!(prepared.execute().await, Err(expected));
        }
    }

    #[test]
    fn citation_metadata_does_not_change_legacy_observation_acceptance() {
        for metadata in ["null", "17", r#"{"unexpected":"shape"}"#] {
            let searx: SearxResponse = serde_json::from_str(&format!(r#"{{"results":[{{"title":"Legacy result","content":"Still useful","url":{metadata}}}]}}"#)).unwrap();
            assert!(
                summarize_searxng(&searx, "query")
                    .unwrap()
                    .contains("Legacy result")
            );
            let serp: SerpResponse = serde_json::from_str(&format!(r#"{{"organic_results":[{{"title":"Legacy result","snippet":"Still useful","link":{metadata}}}]}}"#)).unwrap();
            assert!(
                summarize_serpapi(&serp, "query")
                    .unwrap()
                    .contains("Legacy result")
            );
        }
    }

    #[tokio::test]
    async fn ambiance_lookup_chunked_oversize_is_stopped_without_a_content_length_header() {
        let source = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = lookup_config(Some(format!("http://{}", source.local_addr().unwrap())));
        let handle = tokio::spawn(async move {
            let (mut socket, _) = source.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let mut received = 0;
            loop {
                assert!(
                    received < request.len(),
                    "fixture request headers exceed limit"
                );
                let read = socket.read(&mut request[received..]).await.unwrap();
                assert!(read > 0, "fixture request ended before its headers");
                received += read;
                if request[..received]
                    .windows(4)
                    .any(|bytes| bytes == b"\r\n\r\n")
                {
                    break;
                }
            }
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
            let chunk = "x".repeat(16 * 1024);
            for _ in 0..=MAX_RESPONSE_BYTES / chunk.len() {
                if socket
                    .write_all(format!("{:x}\r\n{chunk}\r\n", chunk.len()).as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
            }
            let _ = socket.write_all(b"0\r\n\r\n").await;
        });
        let identity = lookup_providers_from(&config, SERPAPI_BASE_URL).remove(0);
        let prepared = prepare_lookup_from(
            &identity,
            LookupQuery::new("query").unwrap(),
            &config,
            SERPAPI_BASE_URL,
        )
        .unwrap();
        assert_eq!(prepared.execute().await, Err(LookupError::Oversized));
        handle.await.unwrap();
    }

    #[test]
    fn ambiance_lookup_evidence_limits_rows_and_preserves_whole_valid_urls() {
        let rows: Vec<_> = [
            "javascript:alert(1)".to_owned(),
            "file:///tmp/private".into(),
            "https://user:password@example.org/secret".into(),
            format!("https://example.org/{}", "x".repeat(1024)),
        ]
        .into_iter()
        .chain((0..10).map(|i| format!("https://example.org/source/{i}?a=b#cite")))
        .map(|url| ("💡".repeat(100), "long snippet ".repeat(100), url))
        .collect();
        let evidence = lookup_sources(
            rows.iter()
                .map(|(title, snippet, url)| (&**title, &**snippet, &**url)),
        )
        .unwrap();
        assert_eq!(evidence.len(), 4);
        for (index, source) in evidence.iter().enumerate() {
            assert!(source.title.len() <= MAX_TITLE_BYTES);
            assert!(source.snippet.len() <= MAX_SNIPPET_BYTES);
            assert_eq!(
                source.url,
                format!("https://example.org/source/{index}?a=b#cite")
            );
        }
        let duplicates = [
            ("Title", "One", "https://example.org/same"),
            ("Title", "Two", "https://example.org/same"),
        ];
        assert_eq!(lookup_sources(duplicates.into_iter()).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn ambiance_lookup_privacy_covers_text_beyond_field_caps_and_filtered_fifth_row() {
        let mut cases = vec![
            serde_json::json!({"results":[{
                "title":format!("{} password", "ordinary ".repeat(MAX_TITLE_BYTES)),
                "content":"Visible source", "url":"https://example.org/title"
            }],"privacy":"public"}).to_string(),
            serde_json::json!({"results":[{
                "title":"Visible title", "content":format!("{} password", "ordinary ".repeat(MAX_SNIPPET_BYTES)),
                "url":"https://example.org/snippet"
            }]}).to_string(),
        ];
        let mut rows: Vec<_> = (0..4)
            .map(|index| {
                serde_json::json!({
                    "title":format!("lookup {index}"), "content":"Visible source",
                    "url":format!("https://example.org/{index}")
                })
            })
            .collect();
        rows.push(serde_json::json!({
            "title":"password", "content":"Discarded source", "url":"file:///discarded"
        }));
        cases.push(
            serde_json::json!({"results":rows})
                .to_string()
                .replace("password", "\\u0070assword"),
        );
        for body in cases {
            let (base, request) = serve_once("200 OK", body, Duration::ZERO).await;
            let config = lookup_config(Some(base));
            let provider = lookup_providers_from(&config, SERPAPI_BASE_URL).remove(0);
            let prepared = prepare_lookup_from(
                &provider,
                LookupQuery::new("lookup").unwrap(),
                &config,
                SERPAPI_BASE_URL,
            )
            .unwrap();
            let evidence = prepared.execute().await.unwrap();
            assert_eq!(
                evidence.privacy_floor,
                crate::ambiance::PrivacyClass::Sensitive
            );
            assert!(!evidence.sources.is_empty());
            assert!(evidence.sources.len() <= 4);
            assert!(
                evidence
                    .sources
                    .iter()
                    .all(|source| !source.title.contains("password")
                        && !source.snippet.contains("password")),
                "discarded sensitive text must still raise the retained evidence floor"
            );
            assert!(request.await.unwrap().starts_with("GET /search?"));
        }
    }

    #[tokio::test]
    async fn ambiance_lookup_empty_results_preserve_ignored_and_duplicate_string_privacy() {
        for body in [
            r#"{"results":[],"ignored":"password"}"#,
            r#"{"results":[],"ignored":"\u0070assword","ignored":"ordinary","privacy":"public"}"#,
        ] {
            let (base, request) = serve_once("200 OK", body.into(), Duration::ZERO).await;
            let config = lookup_config(Some(base));
            let provider = lookup_providers_from(&config, SERPAPI_BASE_URL).remove(0);
            let prepared = prepare_lookup_from(
                &provider,
                LookupQuery::new("lookup").unwrap(),
                &config,
                SERPAPI_BASE_URL,
            )
            .unwrap();
            let evidence = prepared.execute().await.unwrap();
            assert!(evidence.sources.is_empty());
            assert_eq!(
                evidence.privacy_floor,
                crate::ambiance::PrivacyClass::Sensitive
            );
            assert!(request.await.unwrap().starts_with("GET /search?"));
        }
        assert_eq!(
            lookup_sources(std::iter::empty()).err(),
            Some(LookupError::NoResult)
        );
    }
}
