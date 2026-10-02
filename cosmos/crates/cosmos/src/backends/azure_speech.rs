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
use tokio::sync::mpsc;
use tokio_stream::{Stream, wrappers::ReceiverStream};

const KEY_ENV: &str = "COSMOS_AZURE_SPEECH_KEY";
const REGION_ENV: &str = "COSMOS_AZURE_SPEECH_REGION";
const VOICE_ENV: &str = "COSMOS_AZURE_SPEECH_VOICE";
const DEFAULT_VOICE: &str = "en-US-AvaMultilingualNeural";
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
const MAX_TEXT_BYTES: usize = 8 * 1024;
const MAX_UNARY_AUDIO_BYTES: usize = 4 * 1024 * 1024 - 128;
const MAX_STREAM_AUDIO_BYTES: usize = 16 * 1024 * 1024;
/// Azure's short-audio speech-to-text REST cap (~60 s of 16 kHz mono PCM).
const MAX_STT_AUDIO_BYTES: usize = 4 * 1024 * 1024;
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
    /// No key and no region: this deployment hosts no speech backend.
    #[error("Azure Speech is not configured")]
    NotConfigured,
    /// A half-set or malformed key or region, or a key Azure refused.
    #[error("Azure Speech configuration is invalid")]
    InvalidConfiguration,
    #[error("speech request is invalid")]
    InvalidRequest,
    #[error("Azure Speech is unavailable")]
    Unavailable,
    #[error("Azure Speech returned too much audio")]
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
            "https://{}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=simple",
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
        let text = text.trim();
        if text.is_empty() || text.len() > MAX_TEXT_BYTES {
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
            .header("User-Agent", "luma-cosmos")
            .body(ssml)
            .send()
            .await
            .map_err(|_| AzureSpeechError::Unavailable)?;
        if !response.status().is_success() {
            return Err(refused(response.status().as_u16()));
        }
        Ok(response)
    }
}

/// An Azure refusal, logged with its status only. 401 and 403 are a key or
/// region Azure does not accept, which the owner fixes in Center. Anything
/// else (429, 5xx) is an outage.
fn refused(status: u16) -> AzureSpeechError {
    if matches!(status, 401 | 403) {
        tracing::warn!(status, "Azure Speech refused the configured key");
        AzureSpeechError::InvalidConfiguration
    } else {
        tracing::warn!(status, "Azure Speech refused the request");
        AzureSpeechError::Unavailable
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
        let (tx, rx) = mpsc::channel(4);
        tokio::spawn(async move {
            let mut total = 0usize;
            let mut saw_audio = false;
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        if chunk.is_empty() {
                            continue;
                        }
                        saw_audio = true;
                        total = total.saturating_add(chunk.len());
                        if total > MAX_STREAM_AUDIO_BYTES {
                            let _ = tx.send(Err(AzureSpeechError::ResponseTooLarge)).await;
                            break;
                        }
                        for part in chunk.chunks(STREAM_CHUNK_BYTES) {
                            if tx.send(Ok(part.to_vec())).await.is_err() {
                                return;
                            }
                        }
                    }
                    Ok(None) => {
                        if !saw_audio {
                            let _ = tx.send(Err(AzureSpeechError::Unavailable)).await;
                        }
                        break;
                    }
                    Err(_) => {
                        let _ = tx.send(Err(AzureSpeechError::Unavailable)).await;
                        break;
                    }
                }
            }
        });
        Ok(Box::pin(ReceiverStream::new(rx)))
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
        AzureSpeechClient::from_configuration()?.ok_or(AzureSpeechError::NotConfigured)
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
    /// result (no speech recognized), NOT an error, so the caller can proceed.
    async fn transcribe(&self, wav: &[u8]) -> Result<String, AzureSpeechError>;
}

#[tonic::async_trait]
impl SpeechRecognitionBackend for AzureSpeechClient {
    async fn transcribe(&self, wav: &[u8]) -> Result<String, AzureSpeechError> {
        if wav.is_empty() || wav.len() > MAX_STT_AUDIO_BYTES {
            return Err(AzureSpeechError::InvalidRequest);
        }
        let response = self
            .http
            .post(&self.stt_endpoint)
            .header("Ocp-Apim-Subscription-Key", self.subscription_key.as_ref())
            .header(
                "Content-Type",
                "audio/wav; codecs=audio/pcm; samplerate=16000",
            )
            .header("Accept", "application/json")
            .header("User-Agent", "luma-cosmos")
            .body(wav.to_vec())
            .send()
            .await
            .map_err(|_| AzureSpeechError::Unavailable)?;
        if !response.status().is_success() {
            return Err(refused(response.status().as_u16()));
        }
        let parsed: SttResponse = response
            .json()
            .await
            .map_err(|_| AzureSpeechError::Unavailable)?;
        match parsed.recognition_status.as_str() {
            "Success" => Ok(parsed.display_text),
            // No speech / silence / babble: an honest empty transcript, not a
            // failure and never an invented one.
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
    async fn transcribe(&self, wav: &[u8]) -> Result<String, AzureSpeechError> {
        Self::client()?.transcribe(wav).await
    }
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
    use axum::{Router, body::Bytes, http::HeaderMap, routing::post};
    use tokio::net::TcpListener;

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
