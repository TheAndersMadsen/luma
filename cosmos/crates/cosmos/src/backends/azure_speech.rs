//! Azure AI Speech adapter for Cosmos's stock `SpeechService` wire contract.
//!
//! Azure is an optional, operator-configured provider. Credentials and utterance
//! text are never logged. The adapter fixes the endpoint to Azure's regional TTS
//! host, rejects redirects, bounds text/audio sizes, and maps all four stock
//! protobuf audio formats one-to-one onto Azure output formats.

use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use reqwest::redirect::Policy;
use tokio_stream::Stream;

const KEY_ENV: &str = "COSMOS_AZURE_SPEECH_KEY";
const REGION_ENV: &str = "COSMOS_AZURE_SPEECH_REGION";
const VOICE_ENV: &str = "COSMOS_AZURE_SPEECH_VOICE";
const DEFAULT_VOICE: &str = "en-US-AvaMultilingualNeural";
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
const MAX_TEXT_BYTES: usize = 8 * 1024;
const MAX_UNARY_AUDIO_BYTES: usize = 4 * 1024 * 1024 - 128;
const MAX_STREAM_AUDIO_BYTES: usize = 16 * 1024 * 1024;
/// Azure short-audio REST accepts at most 60s, 16kHz mono, signed 16-bit PCM.
const MAX_STT_PCM_BYTES: usize = 60 * 16_000 * 2;
const MAX_STT_AUDIO_BYTES: usize = MAX_STT_PCM_BYTES + 64 * 1024;
const MAX_STT_RESPONSE_BYTES: usize = 64 * 1024;
const STREAM_CHUNK_BYTES: usize = 48 * 1024;

pub type SpeechAudioStream =
    Pin<Box<dyn Stream<Item = Result<Vec<u8>, AzureSpeechError>> + Send + 'static>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpeechAudioFormat {
    Riff16Khz16BitMonoPcm,
    Raw16Khz16BitMonoPcm,
    Raw24Khz16BitMonoPcm,
    Audio24Khz160KBitrateMonoMp3,
}

impl SpeechAudioFormat {
    fn azure_name(self) -> &'static str {
        match self {
            Self::Riff16Khz16BitMonoPcm => "riff-16khz-16bit-mono-pcm",
            Self::Raw16Khz16BitMonoPcm => "raw-16khz-16bit-mono-pcm",
            Self::Raw24Khz16BitMonoPcm => "raw-24khz-16bit-mono-pcm",
            Self::Audio24Khz160KBitrateMonoMp3 => "audio-24khz-160kbitrate-mono-mp3",
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, thiserror::Error)]
pub enum AzureSpeechError {
    #[error("Azure Speech configuration is invalid")]
    InvalidConfiguration,
    #[error("speech request is invalid")]
    InvalidRequest,
    #[error("Azure Speech is unavailable")]
    Unavailable,
    #[error("Azure Speech returned too much data")]
    ResponseTooLarge,
}

#[tonic::async_trait]
pub trait SpeechSynthesisBackend: Send + Sync {
    async fn synthesize(
        &self,
        text: &str,
        format: SpeechAudioFormat,
    ) -> Result<Vec<u8>, AzureSpeechError>;

    async fn synthesize_stream(
        &self,
        text: &str,
        format: SpeechAudioFormat,
    ) -> Result<SpeechAudioStream, AzureSpeechError>;
}

#[derive(Clone)]
pub struct AzureSpeechClient {
    http: reqwest::Client,
    /// Azure Speech-to-Text short-audio REST endpoint (shares the subscription key).
    stt_endpoint: String,
    endpoint: String,
    subscription_key: Arc<str>,
    voice: Arc<str>,
}

impl AzureSpeechClient {
    pub fn from_configuration() -> Result<Option<Self>, AzureSpeechError> {
        let key = super::key(KEY_ENV);
        let region = super::key(REGION_ENV);
        if key.is_none() && region.is_none() {
            return Ok(None);
        }
        let key = key.ok_or(AzureSpeechError::InvalidConfiguration)?;
        let region = region.ok_or(AzureSpeechError::InvalidConfiguration)?;
        let voice = super::key(VOICE_ENV).unwrap_or_else(|| DEFAULT_VOICE.to_owned());
        Self::new(key, region, voice).map(Some)
    }

    pub fn new(
        subscription_key: String,
        region: String,
        voice: String,
    ) -> Result<Self, AzureSpeechError> {
        if subscription_key.trim().is_empty()
            || subscription_key.len() > 256
            || !valid_region(&region)
            || !valid_voice(&voice)
        {
            return Err(AzureSpeechError::InvalidConfiguration);
        }
        let endpoint = format!(
            "https://{}.tts.speech.microsoft.com/cognitiveservices/v1",
            region.trim()
        );
        // Azure Speech-to-Text (short-audio REST) shares the subscription key.
        let stt_endpoint = format!(
            "https://{}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1",
            region.trim()
        );
        Self::with_endpoint(subscription_key, voice, endpoint, stt_endpoint)
    }

    fn with_endpoint(
        subscription_key: String,
        voice: String,
        endpoint: String,
        stt_endpoint: String,
    ) -> Result<Self, AzureSpeechError> {
        let http = HTTP
            .get_or_init(|| {
                reqwest::Client::builder()
                    .connect_timeout(Duration::from_secs(4))
                    .timeout(Duration::from_secs(30))
                    .redirect(Policy::none())
                    .build()
                    .unwrap_or_default()
            })
            .clone();
        Ok(Self {
            http,
            endpoint,
            stt_endpoint,
            subscription_key: Arc::from(subscription_key),
            voice: Arc::from(voice),
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test(endpoint: String) -> Self {
        let stt_endpoint = format!("{endpoint}/stt");
        Self::with_endpoint(
            "test-key".to_owned(),
            "en-US-TestNeural".to_owned(),
            endpoint,
            stt_endpoint,
        )
        .expect("valid test Azure Speech client")
    }

    async fn start_request(
        &self,
        text: &str,
        format: SpeechAudioFormat,
    ) -> Result<reqwest::Response, AzureSpeechError> {
        if text.trim().is_empty() || text.len() > MAX_TEXT_BYTES {
            return Err(AzureSpeechError::InvalidRequest);
        }
        let ssml = format!(
            "<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" xml:lang=\"en-US\"><voice name=\"{}\">{}</voice></speak>",
            self.voice,
            escape_xml(text),
        );
        let response = self
            .http
            .post(&self.endpoint)
            .header("Ocp-Apim-Subscription-Key", self.subscription_key.as_ref())
            .header("X-Microsoft-OutputFormat", format.azure_name())
            .header("Content-Type", "application/ssml+xml")
            .header("User-Agent", "ai-pin-revival-cosmos")
            .body(ssml)
            .send()
            .await
            .map_err(|_| AzureSpeechError::Unavailable)?;
        if !response.status().is_success() {
            return Err(AzureSpeechError::Unavailable);
        }
        Ok(response)
    }
}

#[tonic::async_trait]
impl SpeechSynthesisBackend for AzureSpeechClient {
    async fn synthesize(
        &self,
        text: &str,
        format: SpeechAudioFormat,
    ) -> Result<Vec<u8>, AzureSpeechError> {
        let mut response = self.start_request(text, format).await?;
        if response
            .content_length()
            .is_some_and(|length| length as usize > MAX_UNARY_AUDIO_BYTES)
        {
            return Err(AzureSpeechError::ResponseTooLarge);
        }
        let mut audio = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AzureSpeechError::Unavailable)?
        {
            if audio.len().saturating_add(chunk.len()) > MAX_UNARY_AUDIO_BYTES {
                return Err(AzureSpeechError::ResponseTooLarge);
            }
            audio.extend_from_slice(&chunk);
        }
        if audio.is_empty() {
            return Err(AzureSpeechError::Unavailable);
        }
        Ok(audio)
    }

    async fn synthesize_stream(
        &self,
        text: &str,
        format: SpeechAudioFormat,
    ) -> Result<SpeechAudioStream, AzureSpeechError> {
        let mut response = self.start_request(text, format).await?;
        if response
            .content_length()
            .is_some_and(|length| length as usize > MAX_STREAM_AUDIO_BYTES)
        {
            return Err(AzureSpeechError::ResponseTooLarge);
        }
        // The returned stream owns the response and its pending read. Dropping
        // it releases both even if Azure has stopped sending chunks. There is
        // no detached producer, buffered request or background retry.
        Ok(Box::pin(async_stream::try_stream! {
            let mut total = 0usize;
            while let Some(chunk) = response.chunk().await.map_err(|_| AzureSpeechError::Unavailable)? {
                total = total.saturating_add(chunk.len());
                if total > MAX_STREAM_AUDIO_BYTES {
                    Err(AzureSpeechError::ResponseTooLarge)?;
                }
                for part in chunk.chunks(STREAM_CHUNK_BYTES) {
                    yield part.to_vec();
                }
            }
            if total == 0 {
                Err(AzureSpeechError::Unavailable)?;
            }
        }))
    }
}

pub fn configured_backend() -> Option<Arc<dyn SpeechSynthesisBackend>> {
    Some(Arc::new(LiveAzureSpeech))
}

pub fn configured() -> bool {
    AzureSpeechClient::from_configuration()
        .ok()
        .flatten()
        .is_some()
}

#[derive(Clone, Copy)]
struct LiveAzureSpeech;

impl LiveAzureSpeech {
    fn client() -> Result<AzureSpeechClient, AzureSpeechError> {
        AzureSpeechClient::from_configuration()?.ok_or(AzureSpeechError::InvalidConfiguration)
    }
}

#[tonic::async_trait]
impl SpeechSynthesisBackend for LiveAzureSpeech {
    async fn synthesize(
        &self,
        text: &str,
        format: SpeechAudioFormat,
    ) -> Result<Vec<u8>, AzureSpeechError> {
        Self::client()?.synthesize(text, format).await
    }

    async fn synthesize_stream(
        &self,
        text: &str,
        format: SpeechAudioFormat,
    ) -> Result<SpeechAudioStream, AzureSpeechError> {
        Self::client()?.synthesize_stream(text, format).await
    }
}

/// Azure Speech-to-Text short-audio REST response (`format=simple`).
#[derive(serde::Deserialize)]
struct SttResponse {
    #[serde(rename = "RecognitionStatus", default)]
    recognition_status: String,
    #[serde(rename = "DisplayText", default)]
    display_text: String,
}

/// Speech recognition (audio -> text), the reverse of [`SpeechSynthesisBackend`].
#[tonic::async_trait]
pub trait SpeechRecognitionBackend: Send + Sync {
    /// Transcribe RIFF/WAV 16 kHz mono PCM audio to text. Empty text is a valid
    /// result (no speech recognized), NOT an error. The caller must supply an
    /// explicit locale and authorize provider disclosure before this call.
    async fn transcribe(&self, wav: &[u8], locale: &str) -> Result<String, AzureSpeechError>;
}

#[tonic::async_trait]
impl SpeechRecognitionBackend for AzureSpeechClient {
    async fn transcribe(&self, wav: &[u8], locale: &str) -> Result<String, AzureSpeechError> {
        validate_recognition_wav(wav)?;
        if !valid_locale(locale) {
            return Err(AzureSpeechError::InvalidRequest);
        }
        let mut response = self
            .http
            .post(&self.stt_endpoint)
            .query(&[("language", locale), ("format", "simple")])
            .header("Ocp-Apim-Subscription-Key", self.subscription_key.as_ref())
            .header(
                "Content-Type",
                "audio/wav; codecs=audio/pcm; samplerate=16000",
            )
            .header("Accept", "application/json")
            .header("User-Agent", "ai-pin-revival-cosmos")
            .body(wav.to_vec())
            .send()
            .await
            .map_err(|_| AzureSpeechError::Unavailable)?;
        if !response.status().is_success() {
            return Err(AzureSpeechError::Unavailable);
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_STT_RESPONSE_BYTES as u64)
        {
            return Err(AzureSpeechError::ResponseTooLarge);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AzureSpeechError::Unavailable)?
        {
            if body.len().saturating_add(chunk.len()) > MAX_STT_RESPONSE_BYTES {
                return Err(AzureSpeechError::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        let parsed: SttResponse =
            serde_json::from_slice(&body).map_err(|_| AzureSpeechError::Unavailable)?;
        if parsed.display_text.len() > MAX_TEXT_BYTES {
            return Err(AzureSpeechError::ResponseTooLarge);
        }
        match parsed.recognition_status.as_str() {
            "Success" => Ok(parsed.display_text),
            // No successful recognition. NoMatch can also mean a wrong locale;
            // an empty transcript does not establish silence.
            "NoMatch" | "InitialSilenceTimeout" | "BabbleTimeout" | "EndOfDictation" => {
                Ok(String::new())
            }
            _ => Err(AzureSpeechError::Unavailable),
        }
    }
}

pub fn configured_recognition_backend() -> Option<Arc<dyn SpeechRecognitionBackend>> {
    Some(Arc::new(LiveAzureSpeech))
}

#[tonic::async_trait]
impl SpeechRecognitionBackend for LiveAzureSpeech {
    async fn transcribe(&self, wav: &[u8], locale: &str) -> Result<String, AzureSpeechError> {
        Self::client()?.transcribe(wav, locale).await
    }
}

// Do not infer a duration from the whole file size: metadata is not audio, and
// a forged sample rate must not turn a longer recording into an accepted one.
fn validate_recognition_wav(wav: &[u8]) -> Result<(), AzureSpeechError> {
    let invalid = AzureSpeechError::InvalidRequest;
    if wav.len() < 44
        || wav.len() > MAX_STT_AUDIO_BYTES
        || &wav[..4] != b"RIFF"
        || &wav[8..12] != b"WAVE"
        || u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize != wav.len() - 8
    {
        return Err(invalid);
    }
    let (mut position, mut format, mut data) = (12usize, false, false);
    while position < wav.len() {
        let header = wav.get(position..position + 8).ok_or(invalid)?;
        let length = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
        position += 8;
        let end = position.checked_add(length).ok_or(invalid)?;
        let chunk = wav.get(position..end).ok_or(invalid)?;
        match &header[..4] {
            b"fmt " => {
                if format || !(length == 16 || (length == 18 && chunk[16..] == [0, 0])) {
                    return Err(invalid);
                }
                let u16_at = |n| u16::from_le_bytes(chunk[n..n + 2].try_into().unwrap());
                let u32_at = |n| u32::from_le_bytes(chunk[n..n + 4].try_into().unwrap());
                if u16_at(0) != 1
                    || u16_at(2) != 1
                    || u32_at(4) != 16_000
                    || u32_at(8) != 32_000
                    || u16_at(12) != 2
                    || u16_at(14) != 16
                {
                    return Err(invalid);
                }
                format = true;
            }
            b"data" => {
                if !format || data || length == 0 || length % 2 != 0 || length > MAX_STT_PCM_BYTES {
                    return Err(invalid);
                }
                data = true;
            }
            _ => {}
        }
        position = end
            .checked_add(length % 2)
            .filter(|end| *end <= wav.len())
            .ok_or(invalid)?;
    }
    if !data {
        return Err(invalid);
    }
    Ok(())
}

fn valid_locale(value: &str) -> bool {
    let mut parts = value.split('-');
    let language = parts.next().unwrap_or_default();
    value.len() <= 32
        && (2..=3).contains(&language.len())
        && language.bytes().all(|byte| byte.is_ascii_alphabetic())
        && parts.clone().count() > 0
        && parts.all(|part| {
            (2..=8).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

fn valid_region(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_voice(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b' ')
        })
}

fn escape_xml(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '\'' => escaped.push_str("&apos;"),
            '"' => escaped.push_str("&quot;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, Bytes},
        http::HeaderMap,
        routing::post,
    };
    use futures_util::StreamExt;
    use tokio::net::TcpListener;

    fn wav(samples: usize) -> Vec<u8> {
        let bytes = (samples * 2) as u32;
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&(bytes + 36).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&16_000u32.to_le_bytes());
        wav.extend_from_slice(&32_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&bytes.to_le_bytes());
        wav.resize(44 + bytes as usize, 0);
        wav
    }

    #[test]
    fn recognition_validates_actual_duration_format_and_riff_chunks() {
        assert_eq!(validate_recognition_wav(&wav(60 * 16_000)), Ok(()));
        assert_eq!(
            validate_recognition_wav(&wav(60 * 16_000 + 1)),
            Err(AzureSpeechError::InvalidRequest)
        );
        assert_eq!(
            validate_recognition_wav(&wav(0)),
            Err(AzureSpeechError::InvalidRequest)
        );
        // Each invalid encoding/header is independently rejected.
        for (offset, value) in [
            (0, 0),
            (4, 0),
            (8, 0),
            (20, 3),
            (22, 2),
            (24, 0),
            (28, 1),
            (32, 4),
            (34, 8),
            (40, 1),
        ] {
            let mut audio = wav(160);
            audio[offset] = value;
            assert_eq!(
                validate_recognition_wav(&audio),
                Err(AzureSpeechError::InvalidRequest),
                "offset {offset}"
            );
        }
        // Legal padded metadata is ignored without counting it as speech.
        let mut audio = wav(160);
        audio.splice(12..12, *b"JUNK\x01\x00\x00\x00x\x00");
        let length = (audio.len() - 8) as u32;
        audio[4..8].copy_from_slice(&length.to_le_bytes());
        assert_eq!(validate_recognition_wav(&audio), Ok(()));
        // Extra data cannot be hidden in a second data chunk.
        audio.extend_from_slice(b"data\x02\x00\x00\x00\x00\x00");
        let length = (audio.len() - 8) as u32;
        audio[4..8].copy_from_slice(&length.to_le_bytes());
        assert_eq!(
            validate_recognition_wav(&audio),
            Err(AzureSpeechError::InvalidRequest)
        );
        for end in 0..wav(160).len() {
            assert!(validate_recognition_wav(&wav(160)[..end]).is_err());
        }
    }

    #[tokio::test]
    async fn recognition_rejects_invalid_input_before_http_and_sends_explicit_locale() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/speech/stt", post(move |axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>, headers: HeaderMap, body: Bytes| {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(query.get("language").map(String::as_str), Some("da-DK"));
                    assert_eq!(query.get("format").map(String::as_str), Some("simple"));
                    assert_eq!(headers.get("content-type").unwrap(), "audio/wav; codecs=audio/pcm; samplerate=16000");
                    assert_eq!(body.as_ref(), wav(160));
                    axum::Json(serde_json::json!({"RecognitionStatus":"Success", "DisplayText":"Hej fra Cosmos."}))
                }
            }))).await.unwrap();
        });
        let client = AzureSpeechClient::for_test(format!("http://{address}/speech"));
        for locale in ["", "en", "da DK", "da-DK&other=x", " da-DK", "en-US\n"] {
            assert_eq!(
                client.transcribe(&wav(160), locale).await,
                Err(AzureSpeechError::InvalidRequest)
            );
        }
        for audio in [vec![], vec![0; 320], wav(60 * 16_000 + 1)] {
            assert_eq!(
                client.transcribe(&audio, "da-DK").await,
                Err(AzureSpeechError::InvalidRequest)
            );
        }
        assert_eq!(observed.load(Ordering::SeqCst), 0);
        assert_eq!(
            client.transcribe(&wav(160), "da-DK").await.unwrap(),
            "Hej fra Cosmos."
        );
        assert_eq!(observed.load(Ordering::SeqCst), 1);
        assert!(valid_locale("zh-Hans-CN"));
        server.abort();
    }

    #[tokio::test]
    async fn recognition_bounds_responses_and_no_match_never_invents_text() {
        for (response, expected) in [
            (serde_json::json!({"RecognitionStatus":"NoMatch", "DisplayText":"ignore on no match"}).to_string(), Ok(String::new())),
            (serde_json::json!({"RecognitionStatus":"Success", "DisplayText":"x".repeat(MAX_TEXT_BYTES + 1)}).to_string(), Err(AzureSpeechError::ResponseTooLarge)),
            ("x".repeat(MAX_STT_RESPONSE_BYTES + 1), Err(AzureSpeechError::ResponseTooLarge)),
            ("{}".to_owned(), Err(AzureSpeechError::Unavailable)),
        ] {
            // Reuse the fixture's one-shot POST body for the STT endpoint.
            let (mut client, server) = serve(Body::from(response)).await;
            client.stt_endpoint = client.endpoint.clone();
            assert_eq!(client.transcribe(&wav(160), "da-DK").await, expected);
            server.abort();
        }
    }

    async fn serve(body: Body) -> (AzureSpeechClient, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = Arc::new(tokio::sync::Mutex::new(Some(body)));
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/speech",
                    post(move || {
                        let body = body.clone();
                        async move { body.lock().await.take().unwrap() }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        (
            AzureSpeechClient::for_test(format!("http://{address}/speech")),
            server,
        )
    }

    #[tokio::test]
    async fn streaming_drop_closes_a_stalled_http_response() {
        struct Closed(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Closed {
            fn drop(&mut self) {
                let _ = self.0.take().unwrap().send(());
            }
        }
        let (closed, observed) = tokio::sync::oneshot::channel();
        let response = async_stream::stream! {
            let _closed = Closed(Some(closed));
            yield Ok::<_, std::io::Error>(Bytes::from_static(&[1, 2]));
            std::future::pending::<()>().await;
        };
        let (client, server) = serve(Body::from_stream(response)).await;
        let mut stream = client
            .synthesize_stream("fixture", SpeechAudioFormat::Raw24Khz16BitMonoPcm)
            .await
            .unwrap();
        assert_eq!(stream.next().await.unwrap().unwrap(), [1, 2]);
        // Drop while an actual body read is pending, not just before first poll.
        assert!(
            tokio::time::timeout(Duration::from_millis(30), stream.next())
                .await
                .is_err()
        );
        drop(stream);
        tokio::time::timeout(Duration::from_secs(2), observed)
            .await
            .unwrap()
            .unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn streaming_preserves_bytes_across_arbitrary_chunks_with_bounded_yields() {
        let expected: Vec<u8> = (0..(STREAM_CHUNK_BYTES * 3 + 7))
            .map(|n| (n % 251) as u8)
            .collect();
        let chunks = vec![
            expected[..1].to_vec(),
            expected[1..4].to_vec(),
            expected[4..].to_vec(),
        ];
        let response = futures_util::stream::iter(chunks.into_iter().map(Ok::<_, std::io::Error>));
        let (client, server) = serve(Body::from_stream(response)).await;
        let mut stream = client
            .synthesize_stream("fixture", SpeechAudioFormat::Raw24Khz16BitMonoPcm)
            .await
            .unwrap();
        let mut received = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.unwrap();
            assert!(!chunk.is_empty() && chunk.len() <= STREAM_CHUNK_BYTES);
            received.extend(chunk);
        }
        assert_eq!(received, expected);
        server.abort();
    }

    #[tokio::test]
    async fn streaming_empty_or_oversize_audio_fails_and_terminates() {
        for oversized in [false, true] {
            // Streaming body omits Content-Length, exercising the running cap.
            let chunks = if oversized {
                MAX_STREAM_AUDIO_BYTES / STREAM_CHUNK_BYTES + 1
            } else {
                0
            };
            let body = Body::from_stream(futures_util::stream::iter(
                (0..chunks).map(|_| Ok::<_, std::io::Error>(vec![0; STREAM_CHUNK_BYTES])),
            ));
            let (client, server) = serve(body).await;
            let mut stream = client
                .synthesize_stream("fixture", SpeechAudioFormat::Raw24Khz16BitMonoPcm)
                .await
                .unwrap();
            let expected = if oversized {
                AzureSpeechError::ResponseTooLarge
            } else {
                AzureSpeechError::Unavailable
            };
            let mut received = 0;
            loop {
                match stream.next().await.expect("must terminate with an error") {
                    Ok(chunk) => {
                        received += chunk.len();
                        assert!(received <= MAX_STREAM_AUDIO_BYTES);
                    }
                    Err(error) => {
                        assert_eq!(error, expected);
                        break;
                    }
                }
            }
            assert!(stream.next().await.is_none());
            server.abort();
        }
    }

    #[test]
    fn validates_endpoint_components_without_accepting_an_arbitrary_host() {
        assert!(
            AzureSpeechClient::new(
                "secret".to_owned(),
                "eastus".to_owned(),
                "en-US-AvaMultilingualNeural".to_owned(),
            )
            .is_ok()
        );
        assert!(
            AzureSpeechClient::new(
                "secret".to_owned(),
                "https://attacker.invalid".to_owned(),
                "en-US-AvaMultilingualNeural".to_owned(),
            )
            .is_err()
        );
    }

    #[test]
    fn escapes_plain_text_before_placing_it_in_ssml() {
        assert_eq!(
            escape_xml("A < B & \"quoted\""),
            "A &lt; B &amp; &quot;quoted&quot;"
        );
    }

    #[test]
    fn maps_every_stock_audio_format_to_azure() {
        assert_eq!(
            SpeechAudioFormat::Riff16Khz16BitMonoPcm.azure_name(),
            "riff-16khz-16bit-mono-pcm"
        );
        assert_eq!(
            SpeechAudioFormat::Raw16Khz16BitMonoPcm.azure_name(),
            "raw-16khz-16bit-mono-pcm"
        );
        assert_eq!(
            SpeechAudioFormat::Raw24Khz16BitMonoPcm.azure_name(),
            "raw-24khz-16bit-mono-pcm"
        );
        assert_eq!(
            SpeechAudioFormat::Audio24Khz160KBitrateMonoMp3.azure_name(),
            "audio-24khz-160kbitrate-mono-mp3"
        );
    }

    #[tokio::test]
    async fn sends_the_stock_format_to_the_synthesis_contract() {
        async fn synthesize(headers: HeaderMap, body: String) -> Bytes {
            assert_eq!(
                headers
                    .get("x-microsoft-outputformat")
                    .and_then(|value| value.to_str().ok()),
                Some("raw-24khz-16bit-mono-pcm")
            );
            assert_eq!(
                headers
                    .get("ocp-apim-subscription-key")
                    .and_then(|value| value.to_str().ok()),
                Some("test-key")
            );
            assert!(body.contains("A &lt; B &amp; safe"));
            Bytes::from_static(b"\x01\x02\x03\x04")
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/synthesize", post(synthesize)),
            )
            .await
            .expect("serve test Azure endpoint");
        });
        let client = AzureSpeechClient::for_test(format!("http://{address}/synthesize"));
        let audio = client
            .synthesize("A < B & safe", SpeechAudioFormat::Raw24Khz16BitMonoPcm)
            .await
            .expect("synthesize fixture");
        assert_eq!(audio, [1, 2, 3, 4]);
    }

    #[tokio::test]
    #[ignore = "requires an operator-owned Azure Speech resource"]
    async fn live_azure_speech_returns_nonempty_stock_pcm() {
        let client = AzureSpeechClient::from_configuration()
            .expect("valid Azure Speech configuration")
            .expect("Azure Speech settings");
        let audio = client
            .synthesize(
                "Cosmos speech synthesis test.",
                SpeechAudioFormat::Raw24Khz16BitMonoPcm,
            )
            .await
            .expect("live Azure synthesis");
        assert!(!audio.is_empty());
        assert_eq!(audio.len() % 2, 0, "16-bit PCM has complete samples");
    }
}
