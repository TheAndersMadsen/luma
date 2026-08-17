//! Bounded speech-to-text adapter for the stock conversation interpreter.
//!
//! Azure's GA fast-transcription endpoint accepts a complete audio file rather
//! than a live socket. The stock Pin already half-closes each interpreter RPC
//! after one utterance, so we collect at most thirty seconds of raw PCM, wrap it
//! in a WAV header in memory, and submit it once. Neither audio nor transcript
//! is written to disk or retained by this module.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use reqwest::header::{HeaderValue, ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, USER_AGENT};
use reqwest::{Client, StatusCode, Url};
use serde::Deserialize;

use crate::config::ResolvedConfig;

use super::translation::{validate_input_text, ValidatedLocale};

const API_VERSION: &str = "2025-10-15";
const AZURE_API_HOST_SUFFIX: &str = ".api.cognitive.microsoft.com";
const TRANSCRIPTION_PATH: &str = "/speechtotext/transcriptions:transcribe";
const SUBSCRIPTION_KEY_HEADER: &str = "ocp-apim-subscription-key";
const CLIENT_USER_AGENT: &str = "penumbraos-speech/1.0";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ConversationTranscriptionInput {
    pub(super) raw_pcm: Vec<u8>,
    pub(super) candidate_locales: Vec<ValidatedLocale>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ConversationTranscription {
    pub(super) text: String,
    pub(super) locale: ValidatedLocale,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ConversationTranscriptionError {
    FailedToDetectLanguage,
    FailedToTranscribe,
    Timeout,
    Unavailable,
}

#[tonic::async_trait]
pub(super) trait ConversationTranscriber: Send + Sync {
    async fn transcribe(
        &self,
        input: &ConversationTranscriptionInput,
    ) -> Result<ConversationTranscription, ConversationTranscriptionError>;
}

#[derive(Clone)]
pub(super) struct AzureConversationTranscriber {
    http: Client,
    subscription_key: String,
    endpoint: Url,
}

impl std::fmt::Debug for AzureConversationTranscriber {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AzureConversationTranscriber")
            .field("endpoint_host", &self.endpoint.host_str())
            .finish_non_exhaustive()
    }
}

impl AzureConversationTranscriber {
    pub(super) fn configured(config: &ResolvedConfig) -> Option<Arc<dyn ConversationTranscriber>> {
        let speech = &config.config.azure_speech;
        if !speech.enabled || !speech.cloud_consent_acknowledged {
            return None;
        }
        let subscription_key = speech.resolve_subscription_key()?;
        let region = speech.region.as_deref()?.trim();
        let endpoint = endpoint_for_region(region).ok()?;
        Self::new(subscription_key, endpoint)
            .ok()
            .map(|provider| Arc::new(provider) as Arc<dyn ConversationTranscriber>)
    }

    fn new(subscription_key: String, endpoint: Url) -> Result<Self, ()> {
        if subscription_key.is_empty() || subscription_key.len() > 256 {
            return Err(());
        }
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|_| ())?;
        Ok(Self {
            http,
            subscription_key,
            endpoint,
        })
    }

    #[cfg(test)]
    fn for_test(endpoint: Url) -> Self {
        Self::new("0123456789abcdef0123456789abcdef".into(), endpoint).unwrap()
    }
}

#[tonic::async_trait]
impl ConversationTranscriber for AzureConversationTranscriber {
    async fn transcribe(
        &self,
        input: &ConversationTranscriptionInput,
    ) -> Result<ConversationTranscription, ConversationTranscriptionError> {
        if input.raw_pcm.is_empty()
            || !input.raw_pcm.len().is_multiple_of(2)
            || input.candidate_locales.is_empty()
        {
            return Err(ConversationTranscriptionError::FailedToTranscribe);
        }

        let definition = serde_json::to_vec(&serde_json::json!({
            "locales": input
                .candidate_locales
                .iter()
                .map(ValidatedLocale::tag)
                .collect::<Vec<_>>(),
        }))
        .map_err(|_| ConversationTranscriptionError::Unavailable)?;
        let wav = wav_for_raw_16khz_mono_pcm(&input.raw_pcm)
            .ok_or(ConversationTranscriptionError::FailedToTranscribe)?;
        let boundary = format!("penumbra-{}", uuid::Uuid::new_v4().simple());
        let body = multipart_body(&boundary, &definition, &wav);
        let content_type =
            HeaderValue::from_str(&format!("multipart/form-data; boundary={boundary}"))
                .map_err(|_| ConversationTranscriptionError::Unavailable)?;
        let subscription_key = HeaderValue::from_str(&self.subscription_key)
            .map_err(|_| ConversationTranscriptionError::Unavailable)?;

        let response = self
            .http
            .post(self.endpoint.clone())
            .header(SUBSCRIPTION_KEY_HEADER, subscription_key)
            .header(CONTENT_TYPE, content_type)
            .header(ACCEPT, "application/json")
            .header(USER_AGENT, CLIENT_USER_AGENT)
            .body(body)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    ConversationTranscriptionError::Timeout
                } else {
                    ConversationTranscriptionError::Unavailable
                }
            })?;

        if !response.status().is_success() {
            return Err(error_for_status(response.status()));
        }
        let bytes = collect_bounded(response).await?;
        let response: FastTranscriptionResponse = serde_json::from_slice(&bytes)
            .map_err(|_| ConversationTranscriptionError::FailedToTranscribe)?;
        response.into_transcription(&input.candidate_locales)
    }
}

#[derive(Deserialize)]
struct FastTranscriptionResponse {
    #[serde(default, rename = "combinedPhrases")]
    combined_phrases: Vec<CombinedPhrase>,
    #[serde(default)]
    phrases: Vec<RecognizedPhrase>,
}

#[derive(Deserialize)]
struct CombinedPhrase {
    #[serde(default)]
    text: String,
    #[serde(default)]
    locale: Option<String>,
}

#[derive(Deserialize)]
struct RecognizedPhrase {
    #[serde(default)]
    locale: Option<String>,
}

impl FastTranscriptionResponse {
    fn into_transcription(
        self,
        candidates: &[ValidatedLocale],
    ) -> Result<ConversationTranscription, ConversationTranscriptionError> {
        let phrase = self
            .combined_phrases
            .into_iter()
            .find(|phrase| !phrase.text.trim().is_empty())
            .ok_or(ConversationTranscriptionError::FailedToTranscribe)?;
        let text = validate_input_text(&phrase.text)
            .map_err(|_| ConversationTranscriptionError::FailedToTranscribe)?;
        let locale_tag = phrase
            .locale
            .or_else(|| self.phrases.into_iter().find_map(|phrase| phrase.locale))
            .ok_or(ConversationTranscriptionError::FailedToDetectLanguage)?;
        let locale = match_candidate_locale(&locale_tag, candidates)
            .ok_or(ConversationTranscriptionError::FailedToDetectLanguage)?;
        Ok(ConversationTranscription { text, locale })
    }
}

fn match_candidate_locale(
    provider_tag: &str,
    candidates: &[ValidatedLocale],
) -> Option<ValidatedLocale> {
    let provider_tag = provider_tag.trim();
    candidates
        .iter()
        .find(|candidate| candidate.tag().eq_ignore_ascii_case(provider_tag))
        .cloned()
        .or_else(|| {
            let language = provider_tag.split(['-', '_']).next()?.trim();
            let mut matching = candidates
                .iter()
                .filter(|candidate| candidate.language.eq_ignore_ascii_case(language));
            let first = matching.next()?.clone();
            matching.next().is_none().then_some(first)
        })
}

fn wav_for_raw_16khz_mono_pcm(raw_pcm: &[u8]) -> Option<Vec<u8>> {
    let data_length = u32::try_from(raw_pcm.len()).ok()?;
    let riff_length = data_length.checked_add(36)?;
    let mut wav = Vec::with_capacity(44usize.checked_add(raw_pcm.len())?);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_length.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&16_000u32.to_le_bytes());
    wav.extend_from_slice(&32_000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_length.to_le_bytes());
    wav.extend_from_slice(raw_pcm);
    Some(wav)
}

fn multipart_body(boundary: &str, definition: &[u8], wav: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(definition.len() + wav.len() + 512);
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"audio\"; filename=\"utterance.wav\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: audio/wav\r\n\r\n");
    body.extend_from_slice(wav);
    body.extend_from_slice(format!("\r\n--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"definition\"\r\n");
    body.extend_from_slice(b"Content-Type: application/json\r\n\r\n");
    body.extend_from_slice(definition);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

fn endpoint_for_region(region: &str) -> Result<Url, ()> {
    if !(2..=32).contains(&region.len())
        || !region
            .bytes()
            .enumerate()
            .all(|(index, byte)| byte.is_ascii_lowercase() || (index > 0 && byte.is_ascii_digit()))
    {
        return Err(());
    }
    let host = format!("{region}{AZURE_API_HOST_SUFFIX}");
    let endpoint = Url::parse(&format!(
        "https://{host}{TRANSCRIPTION_PATH}?api-version={API_VERSION}"
    ))
    .map_err(|_| ())?;
    if endpoint.scheme() != "https"
        || endpoint.host_str() != Some(host.as_str())
        || endpoint.path() != TRANSCRIPTION_PATH
        || endpoint.query() != Some(&format!("api-version={API_VERSION}"))
        || endpoint.port().is_some()
        || endpoint.fragment().is_some()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return Err(());
    }
    Ok(endpoint)
}

fn error_for_status(status: StatusCode) -> ConversationTranscriptionError {
    match status {
        StatusCode::REQUEST_TIMEOUT | StatusCode::GATEWAY_TIMEOUT => {
            ConversationTranscriptionError::Timeout
        }
        StatusCode::BAD_REQUEST
        | StatusCode::UNPROCESSABLE_ENTITY
        | StatusCode::UNSUPPORTED_MEDIA_TYPE => ConversationTranscriptionError::FailedToTranscribe,
        _ => ConversationTranscriptionError::Unavailable,
    }
}

async fn collect_bounded(
    response: reqwest::Response,
) -> Result<Vec<u8>, ConversationTranscriptionError> {
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(ConversationTranscriptionError::FailedToTranscribe);
    }
    let mut output = Vec::new();
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|_| ConversationTranscriptionError::Unavailable)?;
        if output
            .len()
            .checked_add(chunk.len())
            .is_none_or(|length| length > MAX_RESPONSE_BYTES)
        {
            return Err(ConversationTranscriptionError::FailedToTranscribe);
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::{to_bytes, Body};
    use axum::extract::{Request, State};
    use axum::http::StatusCode as HttpStatusCode;
    use axum::response::Response;
    use axum::routing::post;
    use axum::Router;
    use tokio::net::TcpListener;
    use tokio::sync::Mutex;

    use super::*;

    async fn mock_handler(
        State(captured): State<Arc<Mutex<Vec<u8>>>>,
        request: Request,
    ) -> Response {
        let body = to_bytes(request.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec();
        *captured.lock().await = body;
        Response::builder()
            .status(HttpStatusCode::OK)
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"combinedPhrases":[{"text":"Hello world","locale":"en-US"}]}"#,
            ))
            .unwrap()
    }

    async fn mock_endpoint() -> (Url, Arc<Mutex<Vec<u8>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/transcribe", post(mock_handler))
            .with_state(captured.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (
            Url::parse(&format!("http://{address}/transcribe")).unwrap(),
            captured,
        )
    }

    fn locale(language: &str, country: &str) -> ValidatedLocale {
        ValidatedLocale {
            language: language.into(),
            country: country.into(),
        }
    }

    #[tokio::test]
    async fn azure_fast_transcription_uses_wav_multipart_and_returns_detected_candidate() {
        let (endpoint, captured) = mock_endpoint().await;
        let provider = AzureConversationTranscriber::for_test(endpoint);
        let response = provider
            .transcribe(&ConversationTranscriptionInput {
                raw_pcm: vec![0x00, 0x01, 0x02, 0x03],
                candidate_locales: vec![locale("en", "US"), locale("es", "ES")],
            })
            .await
            .unwrap();
        assert_eq!(response.text, "Hello world");
        assert_eq!(response.locale, locale("en", "US"));

        let captured = captured.lock().await;
        assert!(captured.windows(4).any(|window| window == b"RIFF"));
        assert!(captured
            .windows(4)
            .any(|window| window == [0x00, 0x01, 0x02, 0x03]));
        let rendered = String::from_utf8_lossy(&captured);
        assert!(rendered.contains("name=\"audio\""));
        assert!(rendered.contains("name=\"definition\""));
        assert!(rendered.contains(r#""locales":["en-US","es-ES"]"#));
    }

    #[test]
    fn wav_header_is_stock_input_format_and_region_endpoint_is_pinned() {
        let wav = wav_for_raw_16khz_mono_pcm(&[0x01, 0x02]).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            16_000
        );
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
        assert_eq!(&wav[44..], [0x01, 0x02]);

        let endpoint = endpoint_for_region("westeurope").unwrap();
        assert_eq!(endpoint.scheme(), "https");
        assert_eq!(
            endpoint.host_str(),
            Some("westeurope.api.cognitive.microsoft.com")
        );
        assert_eq!(endpoint.path(), TRANSCRIPTION_PATH);
        assert_eq!(endpoint.query(), Some("api-version=2025-10-15"));
        assert!(endpoint_for_region("https://evil.example").is_err());
        assert!(endpoint_for_region("WestEurope").is_err());
    }

    #[test]
    fn provider_locale_must_unambiguously_match_a_configured_candidate() {
        let candidates = [locale("en", "US"), locale("en", "GB"), locale("es", "ES")];
        assert_eq!(
            match_candidate_locale("es-MX", &candidates),
            Some(locale("es", "ES"))
        );
        assert_eq!(match_candidate_locale("en", &candidates), None);
        assert_eq!(match_candidate_locale("de-DE", &candidates), None);
    }
}
