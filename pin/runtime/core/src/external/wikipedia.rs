//! Bounded, read-only Wikipedia lookup used by the semantic agent loop.
//!
//! Provider text is always returned as untrusted data. The agentic runtime may
//! select an exact UTF-8 span from the extract for another read-only tool, but
//! it never treats the extract as instructions or native-action authority.

use std::time::Duration;

use futures::StreamExt as _;
use reqwest::{StatusCode, Url};

const WIKIPEDIA_API_URL: &str = "https://en.wikipedia.org/w/api.php";
const WIKIPEDIA_USER_AGENT: &str =
    "PenumbraOS/0.1 (+https://github.com/PenumbraOS/humane-system-hook)";
const WIKIPEDIA_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_QUERY_BYTES: usize = 512;
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_SEARCH_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub struct WikipediaClient {
    http: reqwest::Client,
    endpoint: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WikipediaLookupResult {
    pub title: String,
    pub extract: String,
    pub source_url: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WikipediaError {
    InvalidRequest,
    Timeout,
    Transport,
    ProviderRejected,
    ProviderUnavailable,
    ResponseTooLarge,
    NotFound,
    Ambiguous,
    InvalidResponse,
}

impl WikipediaError {
    /// Errors where one immediate retry is reasonable: the provider or the
    /// network hiccuped, and the same query may succeed right away. Definitive
    /// outcomes (not found, ambiguous, rejected, oversized) must not retry.
    pub const fn is_transient(self) -> bool {
        matches!(
            self,
            Self::Timeout | Self::Transport | Self::ProviderUnavailable
        )
    }

    pub const fn kind(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::Timeout => "timeout",
            Self::Transport => "transport",
            Self::ProviderRejected => "provider_rejected",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::ResponseTooLarge => "response_too_large",
            Self::NotFound => "not_found",
            Self::Ambiguous => "ambiguous",
            Self::InvalidResponse => "invalid_response",
        }
    }
}

impl std::fmt::Display for WikipediaError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.kind())
    }
}

impl std::error::Error for WikipediaError {}

impl WikipediaClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            endpoint: WIKIPEDIA_API_URL.to_string(),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_endpoint(mut self, endpoint: String) -> Self {
        self.endpoint = endpoint;
        self
    }

    pub async fn lookup(&self, query: &str) -> Result<WikipediaLookupResult, WikipediaError> {
        let query = validate_query(query)?;
        tokio::time::timeout(WIKIPEDIA_TIMEOUT, self.lookup_validated(query))
            .await
            .map_err(|_| WikipediaError::Timeout)?
    }

    async fn lookup_validated(&self, query: &str) -> Result<WikipediaLookupResult, WikipediaError> {
        match self.lookup_title(query).await {
            Err(WikipediaError::NotFound) => {
                let title = self.search_title(query).await?;
                self.lookup_title(&title).await
            }
            result => result,
        }
    }

    async fn lookup_title(&self, title: &str) -> Result<WikipediaLookupResult, WikipediaError> {
        let mut url =
            Url::parse(&self.endpoint).map_err(|_| WikipediaError::ProviderUnavailable)?;
        url.query_pairs_mut()
            .append_pair("action", "query")
            .append_pair("prop", "extracts|info|pageprops")
            .append_pair("titles", title)
            .append_pair("redirects", "1")
            .append_pair("exintro", "1")
            .append_pair("explaintext", "1")
            .append_pair("inprop", "url")
            .append_pair("format", "json")
            .append_pair("formatversion", "2");

        let json = self.fetch_json(url, MAX_RESPONSE_BYTES).await?;
        parse_lookup_response(&json)
    }

    async fn search_title(&self, query: &str) -> Result<String, WikipediaError> {
        let mut url =
            Url::parse(&self.endpoint).map_err(|_| WikipediaError::ProviderUnavailable)?;
        url.query_pairs_mut()
            .append_pair("action", "opensearch")
            .append_pair("search", query)
            .append_pair("limit", "1")
            .append_pair("namespace", "0")
            .append_pair("format", "json");

        let json = self.fetch_json(url, MAX_SEARCH_RESPONSE_BYTES).await?;
        parse_search_response(&json, query)
    }

    async fn fetch_json(
        &self,
        url: Url,
        max_response_bytes: usize,
    ) -> Result<serde_json::Value, WikipediaError> {
        let requested_url = url.clone();

        let response = self
            .http
            .get(url)
            .header(reqwest::header::USER_AGENT, WIKIPEDIA_USER_AGENT)
            .timeout(WIKIPEDIA_TIMEOUT)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    WikipediaError::Timeout
                } else {
                    WikipediaError::Transport
                }
            })?;

        // The production HTTP client disables redirects. Keep this check here
        // as a defense for independently constructed clients and tests so a
        // provider redirect cannot silently cross the intended trust boundary.
        if response.url() != &requested_url {
            return Err(WikipediaError::ProviderUnavailable);
        }

        match response.status() {
            StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                return Err(WikipediaError::ProviderRejected)
            }
            status if !status.is_success() => return Err(WikipediaError::ProviderUnavailable),
            _ => {}
        }
        if response
            .content_length()
            .is_some_and(|length| length > max_response_bytes as u64)
        {
            return Err(WikipediaError::ResponseTooLarge);
        }

        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| WikipediaError::Transport)?;
            if body.len().saturating_add(chunk.len()) > max_response_bytes {
                return Err(WikipediaError::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| WikipediaError::InvalidResponse)
    }
}

fn validate_query(query: &str) -> Result<&str, WikipediaError> {
    let query = query.trim();
    if query.is_empty()
        || query.len() > MAX_QUERY_BYTES
        || query.chars().any(|character| {
            character == '\0' || (character.is_control() && !character.is_whitespace())
        })
    {
        return Err(WikipediaError::InvalidRequest);
    }
    Ok(query)
}

fn parse_lookup_response(
    json: &serde_json::Value,
) -> Result<WikipediaLookupResult, WikipediaError> {
    let pages = json
        .get("query")
        .and_then(|query| query.get("pages"))
        .and_then(serde_json::Value::as_array)
        .ok_or(WikipediaError::InvalidResponse)?;
    let page = match pages.as_slice() {
        [page] => page,
        [] => return Err(WikipediaError::NotFound),
        _ => return Err(WikipediaError::InvalidResponse),
    };
    if page.get("missing").is_some() {
        return Err(WikipediaError::NotFound);
    }
    if page
        .get("pageprops")
        .and_then(|properties| properties.get("disambiguation"))
        .is_some()
    {
        return Err(WikipediaError::Ambiguous);
    }
    let text = |field: &str| {
        page.get(field)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .filter(|value| {
                !value.chars().any(|character| {
                    character == '\0' || (character.is_control() && !character.is_whitespace())
                })
            })
            .map(ToString::to_string)
    };
    let title = text("title").ok_or(WikipediaError::InvalidResponse)?;
    validate_provider_title(&title)?;
    let source_url = text("fullurl").ok_or(WikipediaError::InvalidResponse)?;
    validate_canonical_wikipedia_url(&source_url)?;
    Ok(WikipediaLookupResult {
        title,
        extract: text("extract").ok_or(WikipediaError::NotFound)?,
        source_url,
    })
}

fn parse_search_response(
    json: &serde_json::Value,
    expected_query: &str,
) -> Result<String, WikipediaError> {
    let response = json.as_array().ok_or(WikipediaError::InvalidResponse)?;
    let [query, titles, descriptions, urls] = response.as_slice() else {
        return Err(WikipediaError::InvalidResponse);
    };
    if query.as_str() != Some(expected_query) {
        return Err(WikipediaError::InvalidResponse);
    }
    let titles = titles.as_array().ok_or(WikipediaError::InvalidResponse)?;
    let descriptions = descriptions
        .as_array()
        .ok_or(WikipediaError::InvalidResponse)?;
    let urls = urls.as_array().ok_or(WikipediaError::InvalidResponse)?;
    let title = match titles.as_slice() {
        [] => return Err(WikipediaError::NotFound),
        [title] => title.as_str().ok_or(WikipediaError::InvalidResponse)?,
        _ => return Err(WikipediaError::Ambiguous),
    };
    if descriptions.len() != 1 || urls.len() != 1 {
        return Err(WikipediaError::InvalidResponse);
    }
    let provider_url = urls[0].as_str().ok_or(WikipediaError::InvalidResponse)?;
    validate_canonical_wikipedia_url(provider_url)?;
    validate_provider_title(title)?;
    Ok(title.to_string())
}

fn validate_canonical_wikipedia_url(value: &str) -> Result<(), WikipediaError> {
    let url = Url::parse(value).map_err(|_| WikipediaError::InvalidResponse)?;
    if url.scheme() != "https"
        || url.host_str() != Some("en.wikipedia.org")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.path().starts_with("/wiki/")
        || url.path() == "/wiki/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(WikipediaError::InvalidResponse);
    }
    Ok(())
}

fn validate_provider_title(title: &str) -> Result<(), WikipediaError> {
    let title = title.trim();
    if title.is_empty()
        || title.len() > MAX_QUERY_BYTES
        || title.chars().any(|character| {
            character == '\0' || (character.is_control() && !character.is_whitespace())
        })
    {
        return Err(WikipediaError::InvalidResponse);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{header, Response};
    use axum::routing::get;
    use axum::Router;

    use super::*;

    #[test]
    fn only_provider_hiccups_are_transient() {
        for error in [
            WikipediaError::Timeout,
            WikipediaError::Transport,
            WikipediaError::ProviderUnavailable,
        ] {
            assert!(error.is_transient(), "{} must retry once", error.kind());
        }
        for error in [
            WikipediaError::InvalidRequest,
            WikipediaError::ProviderRejected,
            WikipediaError::ResponseTooLarge,
            WikipediaError::NotFound,
            WikipediaError::Ambiguous,
            WikipediaError::InvalidResponse,
        ] {
            assert!(
                !error.is_transient(),
                "{} is definitive and must not retry",
                error.kind()
            );
        }
    }

    fn request_parameters(request: &Request) -> Vec<(String, String)> {
        Url::parse(&format!("http://localhost{}", request.uri()))
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect()
    }

    fn parameters_by_name(request: &Request) -> HashMap<String, String> {
        request_parameters(request).into_iter().collect()
    }

    fn json_response(value: serde_json::Value) -> Response<Body> {
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&value).unwrap()))
            .unwrap()
    }

    async fn serve(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}/w/api.php")
    }

    #[test]
    fn parser_accepts_one_bounded_page_and_rejects_missing_or_ambiguous_data() {
        let parsed = parse_lookup_response(&serde_json::json!({
            "query": {"pages": [{
                "title": "France",
                "extract": "Its capital is Paris.",
                "fullurl": "https://en.wikipedia.org/wiki/France"
            }]}
        }))
        .unwrap();
        assert_eq!(parsed.title, "France");
        assert_eq!(parsed.extract, "Its capital is Paris.");

        for invalid in [
            serde_json::json!({"query":{"pages":[]}}),
            serde_json::json!({"query":{"pages":[{"missing":true,"title":"None"}]}}),
            serde_json::json!({"query":{"pages":[{"title":"Paris","extract":"Multiple meanings.","fullurl":"u","pageprops":{"disambiguation":""}}]}}),
            serde_json::json!({"query":{"pages":[{"title":"France","extract":"x","fullurl":"u"},{"title":"Other","extract":"y","fullurl":"v"}]}}),
            serde_json::json!({"query":{"pages":[{"title":"France","extract":"x","fullurl":"https://attacker.invalid/wiki/France"}]}}),
        ] {
            assert!(parse_lookup_response(&invalid).is_err());
        }
    }

    #[test]
    fn search_parser_accepts_only_one_ranked_wikipedia_title() {
        assert_eq!(
            parse_search_response(
                &serde_json::json!([
                    "capitol of France",
                    ["Capital of France"],
                    ["Search result"],
                    ["https://en.wikipedia.org/wiki/Capital_of_France"]
                ]),
                "capitol of France"
            ),
            Ok("Capital of France".to_string())
        );

        for (response, expected) in [
            (
                serde_json::json!(["query", [], [], []]),
                WikipediaError::NotFound,
            ),
            (
                serde_json::json!([
                    "query",
                    ["First", "Second"],
                    ["one", "two"],
                    [
                        "https://en.wikipedia.org/wiki/First",
                        "https://en.wikipedia.org/wiki/Second"
                    ]
                ]),
                WikipediaError::Ambiguous,
            ),
            (
                serde_json::json!([
                    "different query",
                    ["First"],
                    ["one"],
                    ["https://en.wikipedia.org/wiki/First"]
                ]),
                WikipediaError::InvalidResponse,
            ),
            (
                serde_json::json!([
                    "query",
                    ["First"],
                    [],
                    ["https://en.wikipedia.org/wiki/First"]
                ]),
                WikipediaError::InvalidResponse,
            ),
            (
                serde_json::json!([
                    "query",
                    ["First"],
                    ["one"],
                    ["http://attacker.invalid/First"]
                ]),
                WikipediaError::InvalidResponse,
            ),
        ] {
            assert_eq!(parse_search_response(&response, "query"), Err(expected));
        }
    }

    #[tokio::test]
    async fn lookup_encodes_the_title_and_parses_the_provider_response() {
        let requests = Arc::new(AtomicUsize::new(0));
        let handler_requests = Arc::clone(&requests);
        let app = Router::new().route(
            "/w/api.php",
            get(move |request: Request| {
                let requests = Arc::clone(&handler_requests);
                async move {
                requests.fetch_add(1, Ordering::SeqCst);
                assert!(request.uri().query().is_some_and(|query| {
                    query.contains("titles=C%C3%B4te+d%27Ivoire")
                        || query.contains("titles=C%25C3%25B4te")
                }));
                Ok::<_, Infallible>(
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(Body::from(
                            r#"{"query":{"pages":[{"title":"Côte d'Ivoire","extract":"Its capital is Yamoussoukro.","fullurl":"https://en.wikipedia.org/wiki/C%C3%B4te_d%27Ivoire"}]}}"#,
                        ))
                        .unwrap(),
                )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = WikipediaClient::new(reqwest::Client::new())
            .with_test_endpoint(format!("http://{address}/w/api.php"));

        let result = client.lookup("Côte d'Ivoire").await.unwrap();
        assert_eq!(result.title, "Côte d'Ivoire");
        assert_eq!(result.extract, "Its capital is Yamoussoukro.");
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn lookup_falls_back_to_one_ranked_title_for_natural_phrases_and_typos() {
        let app = Router::new().route(
            "/w/api.php",
            get(|request: Request| async move {
                let parameters = parameters_by_name(&request);
                let action = parameters.get("action").map(String::as_str);
                match (action, parameters.get("titles"), parameters.get("search")) {
                    (Some("query"), Some(title), None)
                        if title == "capitol of France" || title == "Frnace" =>
                    {
                        json_response(serde_json::json!({
                            "query": {"pages": [{"title": title, "missing": true}]}
                        }))
                    }
                    (Some("opensearch"), None, Some(query)) => {
                        assert_eq!(parameters.get("limit").map(String::as_str), Some("1"));
                        assert_eq!(parameters.get("namespace").map(String::as_str), Some("0"));
                        let title = match query.as_str() {
                            "capitol of France" => "Capital of France",
                            "Frnace" => "France",
                            other => panic!("unexpected fallback query {other}"),
                        };
                        json_response(serde_json::json!([
                            query,
                            [title],
                            ["Ranked result"],
                            [format!(
                                "https://en.wikipedia.org/wiki/{}",
                                title.replace(' ', "_")
                            )]
                        ]))
                    }
                    (Some("query"), Some(title), None)
                        if title == "Capital of France" || title == "France" =>
                    {
                        let extract = if title == "France" {
                            "France is a country whose capital is Paris."
                        } else {
                            "Paris is the capital of France."
                        };
                        json_response(serde_json::json!({
                            "query": {"pages": [{
                                "title": title,
                                "extract": extract,
                                "fullurl": format!(
                                    "https://en.wikipedia.org/wiki/{}",
                                    title.replace(' ', "_")
                                )
                            }]}
                        }))
                    }
                    other => panic!("unexpected Wikipedia request: {other:?}"),
                }
            }),
        );
        let endpoint = serve(app).await;
        let client = WikipediaClient::new(reqwest::Client::new()).with_test_endpoint(endpoint);

        let natural = client.lookup("capitol of France").await.unwrap();
        assert_eq!(natural.title, "Capital of France");
        assert!(natural.extract.contains("Paris"));

        let typo = client.lookup("Frnace").await.unwrap();
        assert_eq!(typo.title, "France");
        assert!(typo.extract.contains("Paris"));
    }

    #[tokio::test]
    async fn disambiguation_does_not_expand_into_search() {
        let requests = Arc::new(AtomicUsize::new(0));
        let handler_requests = Arc::clone(&requests);
        let app = Router::new().route(
            "/w/api.php",
            get(move |request: Request| {
                let requests = Arc::clone(&handler_requests);
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        parameters_by_name(&request)
                            .get("action")
                            .map(String::as_str),
                        Some("query")
                    );
                    json_response(serde_json::json!({
                        "query": {"pages": [{
                            "title": "Mercury",
                            "extract": "Several meanings.",
                            "fullurl": "https://en.wikipedia.org/wiki/Mercury",
                            "pageprops": {"disambiguation": ""}
                        }]}
                    }))
                }
            }),
        );
        let client =
            WikipediaClient::new(reqwest::Client::new()).with_test_endpoint(serve(app).await);

        assert_eq!(
            client.lookup("Mercury").await,
            Err(WikipediaError::Ambiguous)
        );
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn empty_or_multiple_ranked_results_stop_after_the_bounded_search() {
        let requests = Arc::new(AtomicUsize::new(0));
        let handler_requests = Arc::clone(&requests);
        let app = Router::new().route(
            "/w/api.php",
            get(move |request: Request| {
                let requests = Arc::clone(&handler_requests);
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    let parameters = parameters_by_name(&request);
                    match parameters.get("action").map(String::as_str) {
                        Some("query") => json_response(serde_json::json!({
                            "query": {"pages": [{
                                "title": parameters.get("titles").unwrap(),
                                "missing": true
                            }]}
                        })),
                        Some("opensearch") => {
                            let query = parameters.get("search").unwrap();
                            if query == "nothing relevant" {
                                json_response(serde_json::json!([query, [], [], []]))
                            } else {
                                json_response(serde_json::json!([
                                    query,
                                    ["First", "Second"],
                                    ["one", "two"],
                                    [
                                        "https://en.wikipedia.org/wiki/First",
                                        "https://en.wikipedia.org/wiki/Second"
                                    ]
                                ]))
                            }
                        }
                        other => panic!("unexpected action {other:?}"),
                    }
                }
            }),
        );
        let client =
            WikipediaClient::new(reqwest::Client::new()).with_test_endpoint(serve(app).await);

        assert_eq!(
            client.lookup("nothing relevant").await,
            Err(WikipediaError::NotFound)
        );
        assert_eq!(
            client.lookup("too many results").await,
            Err(WikipediaError::Ambiguous)
        );
        assert_eq!(requests.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn non_not_found_failures_never_expand_into_search() {
        for (status, expected) in [
            (StatusCode::FORBIDDEN, WikipediaError::ProviderRejected),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                WikipediaError::ProviderUnavailable,
            ),
        ] {
            let requests = Arc::new(AtomicUsize::new(0));
            let handler_requests = Arc::clone(&requests);
            let app = Router::new().route(
                "/w/api.php",
                get(move || {
                    let requests = Arc::clone(&handler_requests);
                    async move {
                        requests.fetch_add(1, Ordering::SeqCst);
                        Response::builder()
                            .status(status)
                            .body(Body::empty())
                            .unwrap()
                    }
                }),
            );
            let client =
                WikipediaClient::new(reqwest::Client::new()).with_test_endpoint(serve(app).await);

            assert_eq!(client.lookup("France").await, Err(expected));
            assert_eq!(requests.load(Ordering::SeqCst), 1);
        }

        let malformed_requests = Arc::new(AtomicUsize::new(0));
        let handler_malformed_requests = Arc::clone(&malformed_requests);
        let malformed_app = Router::new().route(
            "/w/api.php",
            get(move || {
                let requests = Arc::clone(&handler_malformed_requests);
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    json_response(serde_json::json!({"unexpected": true}))
                }
            }),
        );
        let malformed_client = WikipediaClient::new(reqwest::Client::new())
            .with_test_endpoint(serve(malformed_app).await);
        assert_eq!(
            malformed_client.lookup("France").await,
            Err(WikipediaError::InvalidResponse)
        );
        assert_eq!(malformed_requests.load(Ordering::SeqCst), 1);

        let transport_requests = Arc::new(AtomicUsize::new(0));
        let handler_transport_requests = Arc::clone(&transport_requests);
        let transport_app = Router::new().route(
            "/w/api.php",
            get(move || {
                let requests = Arc::clone(&handler_transport_requests);
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    let failed_stream = futures::stream::once(async {
                        Err::<bytes::Bytes, std::io::Error>(std::io::Error::other(
                            "provider body interrupted",
                        ))
                    });
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(Body::from_stream(failed_stream))
                        .unwrap()
                }
            }),
        );
        let transport_client = WikipediaClient::new(reqwest::Client::new())
            .with_test_endpoint(serve(transport_app).await);
        assert_eq!(
            transport_client.lookup("France").await,
            Err(WikipediaError::Transport)
        );
        assert_eq!(transport_requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn exact_request_timeout_never_expands_into_search() {
        let requests = Arc::new(AtomicUsize::new(0));
        let handler_requests = Arc::clone(&requests);
        let app = Router::new().route(
            "/w/api.php",
            get(move || {
                let requests = Arc::clone(&handler_requests);
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(WIKIPEDIA_TIMEOUT + Duration::from_secs(1)).await;
                    json_response(serde_json::json!({
                        "query": {"pages": [{"title": "France", "missing": true}]}
                    }))
                }
            }),
        );
        let client =
            WikipediaClient::new(reqwest::Client::new()).with_test_endpoint(serve(app).await);
        let started = std::time::Instant::now();

        assert_eq!(client.lookup("France").await, Err(WikipediaError::Timeout));
        assert!(started.elapsed() >= WIKIPEDIA_TIMEOUT - Duration::from_millis(250));
        assert!(started.elapsed() < WIKIPEDIA_TIMEOUT + Duration::from_secs(1));
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn exact_and_fallback_share_one_outer_four_second_budget() {
        let requests = Arc::new(AtomicUsize::new(0));
        let handler_requests = Arc::clone(&requests);
        let app = Router::new().route(
            "/w/api.php",
            get(move |request: Request| {
                let requests = Arc::clone(&handler_requests);
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    let parameters = parameters_by_name(&request);
                    if parameters.get("action").map(String::as_str) == Some("query") {
                        json_response(serde_json::json!({
                            "query": {"pages": [{"title": "Frnace", "missing": true}]}
                        }))
                    } else {
                        json_response(serde_json::json!([
                            "Frnace",
                            ["France"],
                            ["Ranked result"],
                            ["https://en.wikipedia.org/wiki/France"]
                        ]))
                    }
                }
            }),
        );
        let client =
            WikipediaClient::new(reqwest::Client::new()).with_test_endpoint(serve(app).await);
        let started = std::time::Instant::now();

        assert_eq!(client.lookup("Frnace").await, Err(WikipediaError::Timeout));
        assert!(started.elapsed() >= WIKIPEDIA_TIMEOUT - Duration::from_millis(250));
        assert!(started.elapsed() < WIKIPEDIA_TIMEOUT + Duration::from_secs(1));
        assert_eq!(requests.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn user_and_provider_titles_cannot_inject_query_parameters() {
        let request_number = Arc::new(AtomicUsize::new(0));
        let handler_request_number = Arc::clone(&request_number);
        let malicious_title = "France&action=delete&titles=Poison";
        let app = Router::new().route(
            "/w/api.php",
            get(move |request: Request| {
                let request_number = Arc::clone(&handler_request_number);
                async move {
                    let ordinal = request_number.fetch_add(1, Ordering::SeqCst);
                    let pairs = request_parameters(&request);
                    assert_eq!(pairs.iter().filter(|(name, _)| name == "action").count(), 1);
                    let parameters = pairs.into_iter().collect::<HashMap<_, _>>();
                    match ordinal {
                        0 => {
                            assert_eq!(parameters.get("action").map(String::as_str), Some("query"));
                            assert_eq!(
                                parameters.get("titles").map(String::as_str),
                                Some(malicious_title)
                            );
                            json_response(serde_json::json!({
                                "query": {"pages": [{"title": malicious_title, "missing": true}]}
                            }))
                        }
                        1 => {
                            assert_eq!(
                                parameters.get("action").map(String::as_str),
                                Some("opensearch")
                            );
                            assert_eq!(
                                parameters.get("search").map(String::as_str),
                                Some(malicious_title)
                            );
                            json_response(serde_json::json!([
                                malicious_title,
                                [malicious_title],
                                ["Ranked result"],
                                ["https://en.wikipedia.org/wiki/France"]
                            ]))
                        }
                        2 => {
                            assert_eq!(parameters.get("action").map(String::as_str), Some("query"));
                            assert_eq!(
                                parameters.get("titles").map(String::as_str),
                                Some(malicious_title)
                            );
                            json_response(serde_json::json!({
                                "query": {"pages": [{
                                    "title": "France",
                                    "extract": "Paris is its capital.",
                                    "fullurl": "https://en.wikipedia.org/wiki/France"
                                }]}
                            }))
                        }
                        other => panic!("unexpected request {other}"),
                    }
                }
            }),
        );
        let client =
            WikipediaClient::new(reqwest::Client::new()).with_test_endpoint(serve(app).await);

        assert_eq!(
            client.lookup(malicious_title).await.unwrap().title,
            "France"
        );
        assert_eq!(request_number.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn fallback_response_size_and_redirects_remain_bounded() {
        let oversized_app = Router::new().route(
            "/w/api.php",
            get(|request: Request| async move {
                if parameters_by_name(&request)
                    .get("action")
                    .map(String::as_str)
                    == Some("query")
                {
                    json_response(serde_json::json!({
                        "query": {"pages": [{"title": "missing", "missing": true}]}
                    }))
                } else {
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(Body::from(vec![b'x'; MAX_SEARCH_RESPONSE_BYTES + 1]))
                        .unwrap()
                }
            }),
        );
        let oversized_client = WikipediaClient::new(reqwest::Client::new())
            .with_test_endpoint(serve(oversized_app).await);
        assert_eq!(
            oversized_client.lookup("missing").await,
            Err(WikipediaError::ResponseTooLarge)
        );

        let redirect_app = Router::new()
            .route(
                "/w/api.php",
                get(|| async {
                    Response::builder()
                        .status(StatusCode::FOUND)
                        .header(header::LOCATION, "/redirected")
                        .body(Body::empty())
                        .unwrap()
                }),
            )
            .route(
                "/redirected",
                get(|| async {
                    json_response(serde_json::json!({
                        "query": {"pages": [{
                            "title": "France",
                            "extract": "Paris is its capital.",
                            "fullurl": "https://en.wikipedia.org/wiki/France"
                        }]}
                    }))
                }),
            );
        let redirect_client = WikipediaClient::new(
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
        )
        .with_test_endpoint(serve(redirect_app).await);
        assert_eq!(
            redirect_client.lookup("France").await,
            Err(WikipediaError::ProviderUnavailable)
        );
    }

    #[tokio::test]
    async fn invalid_queries_fail_before_network_access() {
        let client = WikipediaClient::new(reqwest::Client::new());
        for query in ["", "   ", "bad\0query"] {
            assert_eq!(
                client.lookup(query).await,
                Err(WikipediaError::InvalidRequest)
            );
        }
        assert_eq!(
            client.lookup(&"x".repeat(MAX_QUERY_BYTES + 1)).await,
            Err(WikipediaError::InvalidRequest)
        );
        assert_eq!(
            parse_search_response(
                &serde_json::json!([
                    "query",
                    ["x".repeat(MAX_QUERY_BYTES + 1)],
                    ["result"],
                    ["https://en.wikipedia.org/wiki/Oversized"]
                ]),
                "query"
            ),
            Err(WikipediaError::InvalidResponse)
        );
    }
}
