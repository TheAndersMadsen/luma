//! Shared bounded inputs and transport for runtime-authorized lookup services.
//! Provider adapters own their request profiles; configuration is not authority.

use std::{sync::OnceLock, time::Duration};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

pub(super) const MAX_QUERY_BYTES: usize = 512;
pub(super) const MAX_RESPONSE_BYTES: usize = 256 * 1024;
pub(super) const MAX_LOOKUP_URL_BYTES: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LookupService {
    Web,
    Places,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LookupProvider {
    Searxng,
    SerpApi,
    GooglePlaces,
}

impl LookupProvider {
    pub fn service(self) -> LookupService {
        match self {
            Self::Searxng | Self::SerpApi => LookupService::Web,
            Self::GooglePlaces => LookupService::Places,
        }
    }
}

/// Keep field order and web serialization unchanged: existing grants and ledger
/// digests bind these exact three non-secret fields. Service is derived.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LookupProviderIdentity {
    pub provider: LookupProvider,
    pub endpoint: String,
    pub configuration_digest: String,
}

impl LookupProviderIdentity {
    pub fn valid(&self) -> bool {
        if lookup_endpoint(&self.endpoint).is_err() {
            return false;
        }
        let expected = match self.provider.service() {
            LookupService::Web => {
                super::search::lookup_configuration_digest(self.provider, &self.endpoint)
            }
            LookupService::Places => {
                Some(super::places::lookup_configuration_digest(&self.endpoint))
            }
        };
        expected.as_ref() == Some(&self.configuration_digest)
    }
}

/// Normalize once before binding a disclosure. Never truncate into another query.
pub struct LookupQuery(String);

impl LookupQuery {
    pub fn new(raw: &str) -> Result<Self, LookupError> {
        let mut query = String::new();
        for word in raw.split_whitespace() {
            if word.chars().any(char::is_control)
                || query
                    .len()
                    .saturating_add(word.len())
                    .saturating_add(usize::from(!query.is_empty()))
                    > MAX_QUERY_BYTES
            {
                return Err(LookupError::InvalidQuery);
            }
            if !query.is_empty() {
                query.push(' ');
            }
            query.push_str(word);
        }
        if query.is_empty() {
            return Err(LookupError::InvalidQuery);
        }
        Ok(Self(query))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LookupError {
    InvalidQuery,
    InvalidProvider,
    NotConfigured,
    StaleProvider,
    NoResult,
    Malformed,
    Oversized,
    Unavailable,
}

pub(super) fn lookup_endpoint(value: &str) -> Result<reqwest::Url, LookupError> {
    if value.len() > MAX_LOOKUP_URL_BYTES
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
        || value.contains(['\\', '?', '#'])
    {
        return Err(LookupError::InvalidProvider);
    }
    let url = reqwest::Url::parse(value).map_err(|_| LookupError::InvalidProvider)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str() != value
    {
        return Err(LookupError::InvalidProvider);
    }
    Ok(url)
}

pub(super) fn get_payload_digest(url: &reqwest::Url) -> String {
    crate::surface_registry::hash(
        format!("GET\n{}\naccept:application/json\n", url.as_str()).as_bytes(),
    )
}

pub(super) fn lookup_http() -> Result<reqwest::Client, LookupError> {
    static CLIENT: OnceLock<Result<reqwest::Client, LookupError>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .connect_timeout(Duration::from_secs(4))
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .no_proxy()
                .build()
                .map_err(|_| LookupError::Unavailable)
        })
        .clone()
}

pub(super) async fn bounded_body(response: reqwest::Response) -> Result<Vec<u8>, LookupError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(LookupError::Oversized);
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| LookupError::Unavailable)?;
        if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(body.len()) {
            return Err(LookupError::Oversized);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Classify raw and every decoded original JSON string before projection. No
/// response text is logged or retained beyond its bounded lookup future.
pub(super) fn lookup_response_privacy(
    body: &[u8],
) -> Result<crate::ambiance::PrivacyClass, LookupError> {
    let raw = std::str::from_utf8(body).map_err(|_| LookupError::Malformed)?;
    let mut privacy = crate::ambiance::runtime::input_privacy(raw);
    let mut offset = 0;
    while let Some(start) = body[offset..].iter().position(|byte| *byte == b'"') {
        offset += start;
        let mut strings =
            serde_json::Deserializer::from_slice(&body[offset..]).into_iter::<String>();
        let text = strings
            .next()
            .ok_or(LookupError::Malformed)?
            .map_err(|_| LookupError::Malformed)?;
        privacy = privacy.max(crate::ambiance::runtime::input_privacy(&text));
        offset += strings.byte_offset();
    }
    Ok(privacy)
}
