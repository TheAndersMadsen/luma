//! Privacy-preserving Azure AI Speech text-to-speech adapter.
//!
//! This module deliberately owns no application configuration and never reads
//! environment variables. A caller must opt in twice: speech synthesis must be
//! enabled and cloud processing consent must be acknowledged. The production
//! client accepts only Azure's region-derived HTTPS endpoint and disables HTTP
//! redirects so text and subscription credentials cannot be replayed to a
//! redirect target.

use std::fmt;
use std::future::Future as _;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures::{Stream, StreamExt as _};
use reqwest::header::{HeaderValue, ACCEPT, CONTENT_TYPE, USER_AGENT};
use reqwest::redirect::Policy;
use reqwest::{Client, RequestBuilder, Response, StatusCode, Url};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, Sleep};
use tokio_stream::wrappers::ReceiverStream;

const AZURE_SPEECH_HOST_SUFFIX: &str = ".tts.speech.microsoft.com";
const AZURE_SYNTHESIS_PATH: &str = "/cognitiveservices/v1";
const SUBSCRIPTION_KEY_HEADER: &str = "ocp-apim-subscription-key";
const OUTPUT_FORMAT_HEADER: &str = "x-microsoft-outputformat";
const SSML_CONTENT_TYPE: &str = "application/ssml+xml";
const CLIENT_USER_AGENT: &str = "PenumbraOS";

const DEFAULT_LANGUAGE_CODE: &str = "en-US";
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

const MAX_TEXT_BYTES: usize = 8 * 1024;
const MAX_SSML_BYTES: usize = 64 * 1024;
const MAX_AUDIO_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const STREAMING_RESPONSE_BUFFER_CHUNKS: usize = 2;
const MAX_STREAMING_PROVIDER_CHUNK_BYTES: usize = 64 * 1024;
const MAX_SUBSCRIPTION_KEY_BYTES: usize = 256;
const MAX_REGION_BYTES: usize = 32;
const MAX_VOICE_NAME_BYTES: usize = 128;

/// The four Azure output formats that map one-to-one to the stock
/// `humane.aibus.AudioFormat` enum.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AzureSpeechOutputFormat {
    /// Stock `RIFF_16KHZ_16BIT_MONO_PCM` (enum value 0).
    #[default]
    Riff16Khz16BitMonoPcm,
    /// Stock `RAW_16KHZ_16BIT_MONO_PCM` (enum value 1).
    Raw16Khz16BitMonoPcm,
    /// Stock `RAW_24KHZ_16BIT_MONO_PCM` (enum value 2).
    Raw24Khz16BitMonoPcm,
    /// Stock `AUDIO_24KHZ_160KBITRATE_MONO_MP3` (enum value 3).
    Audio24Khz160KBitrateMonoMp3,
}

impl AzureSpeechOutputFormat {
    pub fn azure_header_value(self) -> &'static str {
        match self {
            Self::Riff16Khz16BitMonoPcm => "riff-16khz-16bit-mono-pcm",
            Self::Raw16Khz16BitMonoPcm => "raw-16khz-16bit-mono-pcm",
            Self::Raw24Khz16BitMonoPcm => "raw-24khz-16bit-mono-pcm",
            Self::Audio24Khz160KBitrateMonoMp3 => "audio-24khz-160kbitrate-mono-mp3",
        }
    }
}

/// Explicit, secret-safe Azure Speech configuration.
///
/// A subscription key by itself is intentionally insufficient. Region and
/// voice must also be configured, and both opt-in gates must be true before a
/// request can leave the server.
#[derive(Clone)]
pub struct AzureSpeechOptions {
    subscription_key: Option<String>,
    region: Option<String>,
    voice_name: Option<String>,
    language_code: String,
    output_format: AzureSpeechOutputFormat,
    enabled: bool,
    cloud_consent_acknowledged: bool,
    request_timeout: Duration,
    connect_timeout: Duration,
}

impl Default for AzureSpeechOptions {
    fn default() -> Self {
        Self {
            subscription_key: None,
            region: None,
            voice_name: None,
            language_code: DEFAULT_LANGUAGE_CODE.to_string(),
            output_format: AzureSpeechOutputFormat::default(),
            enabled: false,
            cloud_consent_acknowledged: false,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
        }
    }
}

impl fmt::Debug for AzureSpeechOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AzureSpeechOptions")
            .field("has_subscription_key", &self.subscription_key.is_some())
            .field("has_region", &self.region.is_some())
            .field("has_voice_name", &self.voice_name.is_some())
            .field("language_code", &self.language_code)
            .field("output_format", &self.output_format)
            .field("enabled", &self.enabled)
            .field(
                "cloud_consent_acknowledged",
                &self.cloud_consent_acknowledged,
            )
            .field("request_timeout", &self.request_timeout)
            .field("connect_timeout", &self.connect_timeout)
            .finish()
    }
}

impl AzureSpeechOptions {
    pub fn new(
        subscription_key: Option<String>,
        region: Option<String>,
        voice_name: Option<String>,
    ) -> Self {
        let voice_name = voice_name.and_then(trimmed_nonempty);
        let language_code = voice_name
            .as_deref()
            .and_then(language_prefix_from_voice)
            .unwrap_or(DEFAULT_LANGUAGE_CODE)
            .to_string();

        Self {
            subscription_key: subscription_key.and_then(trimmed_nonempty),
            region: region.and_then(trimmed_nonempty),
            voice_name,
            language_code,
            ..Self::default()
        }
    }

    pub fn with_enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    /// Acknowledge that sending text to Azure is permitted by the operator's
    /// privacy notice, data-processing terms, and user-consent model.
    pub fn with_cloud_consent_acknowledged(mut self, acknowledged: bool) -> Self {
        self.cloud_consent_acknowledged = acknowledged;
        self
    }

    #[cfg(test)]
    pub fn with_request_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    #[cfg(test)]
    pub fn with_connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    #[cfg(test)]
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    #[cfg(test)]
    pub fn cloud_consent_acknowledged(&self) -> bool {
        self.cloud_consent_acknowledged
    }

    #[cfg(test)]
    pub fn has_subscription_key(&self) -> bool {
        self.subscription_key.is_some()
    }

    #[cfg(test)]
    pub fn region(&self) -> Option<&str> {
        self.region.as_deref()
    }

    #[cfg(test)]
    pub fn voice_name(&self) -> Option<&str> {
        self.voice_name.as_deref()
    }

    #[cfg(test)]
    pub fn language_code(&self) -> &str {
        &self.language_code
    }

    #[cfg(test)]
    pub fn output_format(&self) -> AzureSpeechOutputFormat {
        self.output_format
    }

    /// Validate all configuration needed to synthesize speech. The returned
    /// error deliberately does not identify which secret/configuration field
    /// is absent or malformed.
    pub fn validate(&self) -> Result<(), AzureSpeechError> {
        self.validated_configuration().map(|_| ())
    }

    fn validate_transport_options(&self) -> Result<(), AzureSpeechError> {
        if self.request_timeout.is_zero() || self.request_timeout > MAX_REQUEST_TIMEOUT {
            return Err(AzureSpeechError::NotConfigured);
        }
        if self.connect_timeout.is_zero() || self.connect_timeout > MAX_CONNECT_TIMEOUT {
            return Err(AzureSpeechError::NotConfigured);
        }
        Ok(())
    }

    fn validated_configuration(&self) -> Result<ValidatedConfiguration<'_>, AzureSpeechError> {
        self.validate_transport_options()?;

        let subscription_key = self
            .subscription_key
            .as_deref()
            .filter(|key| valid_subscription_key(key))
            .ok_or(AzureSpeechError::NotConfigured)?;
        let region = self
            .region
            .as_deref()
            .filter(|region| valid_region(region))
            .ok_or(AzureSpeechError::NotConfigured)?;
        let voice_name = self
            .voice_name
            .as_deref()
            .filter(|voice| valid_voice_name(voice, &self.language_code))
            .ok_or(AzureSpeechError::NotConfigured)?;
        if !valid_language_code(&self.language_code) {
            return Err(AzureSpeechError::NotConfigured);
        }

        Ok(ValidatedConfiguration {
            subscription_key,
            region,
            voice_name,
            language_code: &self.language_code,
        })
    }
}

struct ValidatedConfiguration<'a> {
    subscription_key: &'a str,
    region: &'a str,
    voice_name: &'a str,
    language_code: &'a str,
}

fn trimmed_nonempty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Azure Speech client. Its Debug representation never includes credentials,
/// request text, SSML, response audio, or provider response bodies.
#[derive(Clone)]
pub struct AzureSpeechClient {
    http: Client,
    options: AzureSpeechOptions,
    #[cfg(test)]
    endpoint_override: Option<Url>,
    #[cfg(test)]
    maximum_response_bytes: usize,
    #[cfg(test)]
    stream_termination_flag: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

impl fmt::Debug for AzureSpeechClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AzureSpeechClient")
            .field("options", &self.options)
            .finish_non_exhaustive()
    }
}

impl AzureSpeechClient {
    /// Construct a production client. Redirects are disabled and only the
    /// region-derived official HTTPS endpoint is used.
    pub fn from_options(options: AzureSpeechOptions) -> Result<Self, AzureSpeechError> {
        options.validate_transport_options()?;
        let http = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(options.connect_timeout)
            .build()
            .map_err(|_| AzureSpeechError::Transport)?;
        Ok(Self {
            http,
            options,
            #[cfg(test)]
            endpoint_override: None,
            #[cfg(test)]
            maximum_response_bytes: MAX_AUDIO_RESPONSE_BYTES,
            #[cfg(test)]
            stream_termination_flag: None,
        })
    }

    #[cfg(test)]
    pub fn disabled() -> Result<Self, AzureSpeechError> {
        Self::from_options(AzureSpeechOptions::default())
    }

    #[cfg(test)]
    pub fn options(&self) -> &AzureSpeechOptions {
        &self.options
    }

    #[cfg(test)]
    pub(crate) fn with_test_endpoint(mut self, endpoint: Url) -> Self {
        self.endpoint_override = Some(endpoint);
        self
    }

    // Test seam for the stream-termination path (`stream_termination_flag`, read in
    // the synthesis loop). Kept to enable exercising that path even while unused.
    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn with_test_stream_termination_flag(
        mut self,
        flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        self.stream_termination_flag = Some(flag);
        self
    }

    /// Synthesize plain text. Callers cannot provide raw SSML. Text, voice and
    /// language are always XML-escaped before building a fixed SSML envelope.
    #[cfg(test)]
    pub async fn synthesize(&self, text: &str) -> Result<SynthesizedSpeech, AzureSpeechError> {
        self.synthesize_with_format(text, self.options.output_format)
            .await
    }

    /// Synthesize plain text in one of the stock device audio formats.
    ///
    /// The output format may vary per request, but the configured voice and
    /// language cannot be overridden by request data.
    pub async fn synthesize_with_format(
        &self,
        text: &str,
        output_format: AzureSpeechOutputFormat,
    ) -> Result<SynthesizedSpeech, AzureSpeechError> {
        #[cfg(test)]
        let maximum_response_bytes = self.maximum_response_bytes;
        #[cfg(not(test))]
        let maximum_response_bytes = MAX_AUDIO_RESPONSE_BYTES;

        self.synthesize_with_format_limit(text, output_format, maximum_response_bytes)
            .await
    }

    /// Synthesize speech while applying a caller-specific response ceiling.
    ///
    /// Unary stock clients retain gRPC's default 4 MiB inbound message limit,
    /// while the streaming RPC can safely consume the provider ceiling in
    /// bounded chunks. Keeping the limit in the response collector avoids
    /// downloading an unusable unary response before falling back locally.
    pub(crate) async fn synthesize_with_format_bounded(
        &self,
        text: &str,
        output_format: AzureSpeechOutputFormat,
        maximum_response_bytes: usize,
    ) -> Result<SynthesizedSpeech, AzureSpeechError> {
        #[cfg(test)]
        let maximum_response_bytes = maximum_response_bytes.min(self.maximum_response_bytes);
        #[cfg(not(test))]
        let maximum_response_bytes = maximum_response_bytes.min(MAX_AUDIO_RESPONSE_BYTES);

        self.synthesize_with_format_limit(text, output_format, maximum_response_bytes)
            .await
    }

    /// Begin a bounded streaming synthesis request.
    ///
    /// Only plain text crosses this boundary. The fixed, XML-escaped SSML
    /// envelope is still built internally. Successful provider bytes are
    /// delivered incrementally through a small bounded channel. Dropping the
    /// returned stream cancels the provider-body task immediately.
    pub(crate) async fn synthesize_stream_with_format(
        &self,
        text: &str,
        output_format: AzureSpeechOutputFormat,
        maximum_chunk_bytes: usize,
        deadline: Instant,
    ) -> Result<AzureSpeechStream, AzureSpeechError> {
        if maximum_chunk_bytes == 0 {
            return Err(AzureSpeechError::NotConfigured);
        }
        if Instant::now() >= deadline {
            return Err(AzureSpeechError::DeadlineExceeded);
        }

        let request = self.synthesis_request(text, output_format)?;
        let response = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => {
                return Err(AzureSpeechError::DeadlineExceeded);
            }
            response = request.send() => {
                response.map_err(|_| AzureSpeechError::Transport)?
            }
        };

        if !response.status().is_success() {
            return Err(error_for_http_status(response.status()));
        }

        #[cfg(test)]
        let maximum_response_bytes = self.maximum_response_bytes;
        #[cfg(not(test))]
        let maximum_response_bytes = MAX_AUDIO_RESPONSE_BYTES;
        reject_oversized_content_length(&response, maximum_response_bytes)?;

        if Instant::now() >= deadline {
            return Err(AzureSpeechError::DeadlineExceeded);
        }

        let maximum_chunk_bytes = maximum_chunk_bytes.min(MAX_STREAMING_PROVIDER_CHUNK_BYTES);
        #[cfg(test)]
        let termination_flag = self.stream_termination_flag.clone();
        Ok(start_bounded_audio_stream(
            response.bytes_stream(),
            maximum_response_bytes,
            maximum_chunk_bytes,
            deadline,
            #[cfg(test)]
            termination_flag,
        ))
    }

    async fn synthesize_with_format_limit(
        &self,
        text: &str,
        output_format: AzureSpeechOutputFormat,
        maximum_response_bytes: usize,
    ) -> Result<SynthesizedSpeech, AzureSpeechError> {
        let response = self
            .synthesis_request(text, output_format)?
            .send()
            .await
            .map_err(|_| AzureSpeechError::Transport)?;

        if !response.status().is_success() {
            return Err(error_for_http_status(response.status()));
        }

        let audio = collect_bounded_response(response, maximum_response_bytes).await?;
        if audio.is_empty() {
            return Err(AzureSpeechError::EmptyResponse);
        }

        Ok(SynthesizedSpeech {
            audio,
            output_format,
        })
    }

    fn synthesis_request(
        &self,
        text: &str,
        output_format: AzureSpeechOutputFormat,
    ) -> Result<RequestBuilder, AzureSpeechError> {
        if !self.options.enabled {
            return Err(AzureSpeechError::Disabled);
        }
        if !self.options.cloud_consent_acknowledged {
            return Err(AzureSpeechError::CloudConsentRequired);
        }

        validate_text(text)?;
        let configuration = self.options.validated_configuration()?;
        let ssml = build_ssml(text, configuration.voice_name, configuration.language_code)?;
        let subscription_key = HeaderValue::from_str(configuration.subscription_key)
            .map_err(|_| AzureSpeechError::NotConfigured)?;
        let endpoint = self.synthesis_endpoint(configuration.region)?;

        Ok(self
            .http
            .post(endpoint)
            .header(SUBSCRIPTION_KEY_HEADER, subscription_key)
            .header(OUTPUT_FORMAT_HEADER, output_format.azure_header_value())
            .header(CONTENT_TYPE, SSML_CONTENT_TYPE)
            .header(ACCEPT, "audio/*")
            .header(USER_AGENT, CLIENT_USER_AGENT)
            .body(ssml)
            .timeout(self.options.request_timeout))
    }

    fn synthesis_endpoint(&self, region: &str) -> Result<Url, AzureSpeechError> {
        #[cfg(test)]
        if let Some(endpoint) = self.endpoint_override.clone() {
            return Ok(endpoint);
        }
        endpoint_for_region(region)
    }
}

/// Bounded provider-audio stream. A terminal provider error or deadline is
/// emitted at most once, then the stream closes. Debug output is intentionally
/// omitted so buffered audio can never be rendered accidentally.
pub(crate) struct AzureSpeechStream {
    receiver: ReceiverStream<Result<Bytes, AzureSpeechError>>,
    cancellation: Option<oneshot::Sender<()>>,
    deadline: Pin<Box<Sleep>>,
    terminated: bool,
}

impl AzureSpeechStream {
    fn cancel_producer(&mut self) {
        if let Some(cancellation) = self.cancellation.take() {
            let _ = cancellation.send(());
        }
    }
}

impl Stream for AzureSpeechStream {
    type Item = Result<Bytes, AzureSpeechError>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.as_mut().get_mut();
        if this.terminated {
            return Poll::Ready(None);
        }

        // Deadline wins over already-buffered audio. This prevents stale audio
        // from escaping after a backpressured consumer resumes.
        if this.deadline.as_mut().poll(context).is_ready() {
            this.terminated = true;
            this.receiver.close();
            this.cancel_producer();
            return Poll::Ready(Some(Err(AzureSpeechError::DeadlineExceeded)));
        }

        match Pin::new(&mut this.receiver).poll_next(context) {
            Poll::Ready(Some(Ok(chunk))) => Poll::Ready(Some(Ok(chunk))),
            Poll::Ready(Some(Err(error))) => {
                this.terminated = true;
                this.receiver.close();
                this.cancel_producer();
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                this.terminated = true;
                this.cancel_producer();
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for AzureSpeechStream {
    fn drop(&mut self) {
        self.receiver.close();
        self.cancel_producer();
    }
}

fn start_bounded_audio_stream<S, E>(
    provider: S,
    maximum_response_bytes: usize,
    maximum_chunk_bytes: usize,
    deadline: Instant,
    #[cfg(test)] termination_flag: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> AzureSpeechStream
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: Send + 'static,
{
    let (sender, receiver) = mpsc::channel(STREAMING_RESPONSE_BUFFER_CHUNKS);
    let (cancel_sender, cancel_receiver) = oneshot::channel();
    tokio::spawn(async move {
        #[cfg(test)]
        let _termination_guard = StreamTerminationGuard(termination_flag);
        forward_bounded_audio(
            provider,
            sender,
            cancel_receiver,
            maximum_response_bytes,
            maximum_chunk_bytes,
            deadline,
        )
        .await;
    });

    AzureSpeechStream {
        receiver: ReceiverStream::new(receiver),
        cancellation: Some(cancel_sender),
        deadline: Box::pin(tokio::time::sleep_until(deadline)),
        terminated: false,
    }
}

async fn forward_bounded_audio<S, E>(
    provider: S,
    sender: mpsc::Sender<Result<Bytes, AzureSpeechError>>,
    mut cancellation: oneshot::Receiver<()>,
    maximum_response_bytes: usize,
    maximum_chunk_bytes: usize,
    deadline: Instant,
) where
    S: Stream<Item = Result<Bytes, E>> + Send,
    E: Send,
{
    futures::pin_mut!(provider);
    let mut received_bytes = 0usize;

    loop {
        let next = tokio::select! {
            biased;
            _ = &mut cancellation => return,
            _ = tokio::time::sleep_until(deadline) => return,
            next = provider.next() => next,
        };

        match next {
            Some(Ok(chunk)) if chunk.is_empty() => continue,
            Some(Ok(chunk)) => {
                let Some(next_received_bytes) = received_bytes.checked_add(chunk.len()) else {
                    let _ = send_stream_result(
                        &sender,
                        &mut cancellation,
                        deadline,
                        Err(AzureSpeechError::ResponseTooLarge),
                    )
                    .await;
                    return;
                };
                if next_received_bytes > maximum_response_bytes {
                    let _ = send_stream_result(
                        &sender,
                        &mut cancellation,
                        deadline,
                        Err(AzureSpeechError::ResponseTooLarge),
                    )
                    .await;
                    return;
                }
                received_bytes = next_received_bytes;

                for provider_chunk in chunk.chunks(maximum_chunk_bytes) {
                    // Copy only the bounded outgoing slice so a small queued
                    // chunk never retains a much larger provider allocation.
                    let provider_chunk = Bytes::copy_from_slice(provider_chunk);
                    if !send_stream_result(&sender, &mut cancellation, deadline, Ok(provider_chunk))
                        .await
                    {
                        return;
                    }
                }
            }
            Some(Err(_)) => {
                let _ = send_stream_result(
                    &sender,
                    &mut cancellation,
                    deadline,
                    Err(AzureSpeechError::Transport),
                )
                .await;
                return;
            }
            None if received_bytes == 0 => {
                let _ = send_stream_result(
                    &sender,
                    &mut cancellation,
                    deadline,
                    Err(AzureSpeechError::EmptyResponse),
                )
                .await;
                return;
            }
            None => return,
        }
    }
}

async fn send_stream_result(
    sender: &mpsc::Sender<Result<Bytes, AzureSpeechError>>,
    cancellation: &mut oneshot::Receiver<()>,
    deadline: Instant,
    result: Result<Bytes, AzureSpeechError>,
) -> bool {
    tokio::select! {
        biased;
        _ = &mut *cancellation => false,
        _ = tokio::time::sleep_until(deadline) => false,
        sent = sender.send(result) => sent.is_ok(),
    }
}

#[cfg(test)]
struct StreamTerminationGuard(Option<std::sync::Arc<std::sync::atomic::AtomicBool>>);

#[cfg(test)]
impl Drop for StreamTerminationGuard {
    fn drop(&mut self) {
        if let Some(flag) = self.0.as_ref() {
            flag.store(true, std::sync::atomic::Ordering::Release);
        }
    }
}

/// Successful synthesized audio. Debug output reports only byte length and
/// format. Audio content is never rendered.
#[derive(PartialEq, Eq)]
pub struct SynthesizedSpeech {
    audio: Vec<u8>,
    output_format: AzureSpeechOutputFormat,
}

impl fmt::Debug for SynthesizedSpeech {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SynthesizedSpeech")
            .field("audio_bytes", &self.audio.len())
            .field("output_format", &self.output_format)
            .finish()
    }
}

impl SynthesizedSpeech {
    pub fn into_audio(self) -> Vec<u8> {
        self.audio
    }
}

/// Provider failures contain classifications and trusted static messages only.
/// They never retain a reqwest error, URL, header, request body, or provider
/// response body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AzureSpeechError {
    Disabled,
    CloudConsentRequired,
    NotConfigured,
    InvalidRequest(&'static str),
    BadRequest,
    RateLimited,
    Transport,
    ProviderUnavailable,
    EmptyResponse,
    ResponseTooLarge,
    DeadlineExceeded,
}

impl AzureSpeechError {
    pub fn kind(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::CloudConsentRequired => "cloud_consent_required",
            Self::NotConfigured => "not_configured",
            Self::InvalidRequest(_) => "invalid_request",
            Self::BadRequest => "bad_request",
            Self::RateLimited => "rate_limited",
            Self::Transport => "transport",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::EmptyResponse => "empty_response",
            Self::ResponseTooLarge => "response_too_large",
            Self::DeadlineExceeded => "deadline_exceeded",
        }
    }
}

impl fmt::Display for AzureSpeechError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) => write!(f, "invalid speech request: {message}"),
            other => write!(f, "speech provider error: {}", other.kind()),
        }
    }
}

impl std::error::Error for AzureSpeechError {}

fn error_for_http_status(status: StatusCode) -> AzureSpeechError {
    match status {
        StatusCode::BAD_REQUEST
        | StatusCode::PAYLOAD_TOO_LARGE
        | StatusCode::UNSUPPORTED_MEDIA_TYPE => AzureSpeechError::BadRequest,
        StatusCode::TOO_MANY_REQUESTS => AzureSpeechError::RateLimited,
        _ => AzureSpeechError::ProviderUnavailable,
    }
}

async fn collect_bounded_response(
    response: Response,
    maximum_bytes: usize,
) -> Result<Vec<u8>, AzureSpeechError> {
    reject_oversized_content_length(&response, maximum_bytes)?;

    let mut output = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| AzureSpeechError::Transport)?;
        let next_length = output
            .len()
            .checked_add(chunk.len())
            .ok_or(AzureSpeechError::ResponseTooLarge)?;
        if next_length > maximum_bytes {
            return Err(AzureSpeechError::ResponseTooLarge);
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn reject_oversized_content_length(
    response: &Response,
    maximum_bytes: usize,
) -> Result<(), AzureSpeechError> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum_bytes as u64)
    {
        return Err(AzureSpeechError::ResponseTooLarge);
    }
    Ok(())
}

fn endpoint_for_region(region: &str) -> Result<Url, AzureSpeechError> {
    if !valid_region(region) {
        return Err(AzureSpeechError::NotConfigured);
    }

    let expected_host = format!("{region}{AZURE_SPEECH_HOST_SUFFIX}");
    let endpoint = Url::parse(&format!("https://{expected_host}{AZURE_SYNTHESIS_PATH}"))
        .map_err(|_| AzureSpeechError::NotConfigured)?;
    if endpoint.scheme() != "https"
        || endpoint.host_str() != Some(expected_host.as_str())
        || endpoint.path() != AZURE_SYNTHESIS_PATH
        || endpoint.port().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return Err(AzureSpeechError::NotConfigured);
    }
    Ok(endpoint)
}

fn valid_subscription_key(key: &str) -> bool {
    let length = key.len();
    (8..=MAX_SUBSCRIPTION_KEY_BYTES).contains(&length)
        && key.bytes().all(|byte| byte.is_ascii_graphic())
}

fn valid_region(region: &str) -> bool {
    let length = region.len();
    (2..=MAX_REGION_BYTES).contains(&length)
        && region
            .bytes()
            .enumerate()
            .all(|(index, byte)| byte.is_ascii_lowercase() || (index > 0 && byte.is_ascii_digit()))
}

fn valid_language_code(language_code: &str) -> bool {
    let Some((language, territory)) = language_code.split_once('-') else {
        return false;
    };
    !territory.contains('-')
        && (2..=3).contains(&language.len())
        && language.bytes().all(|byte| byte.is_ascii_lowercase())
        && territory.len() == 2
        && territory.bytes().all(|byte| byte.is_ascii_uppercase())
}

fn language_prefix_from_voice(voice_name: &str) -> Option<&str> {
    let mut segments = voice_name.split('-');
    let language = segments.next()?;
    let territory = segments.next()?;
    let prefix_length = language
        .len()
        .checked_add(territory.len())?
        .checked_add(1)?;
    let prefix = voice_name.get(..prefix_length)?;
    valid_language_code(prefix).then_some(prefix)
}

fn valid_voice_name(voice_name: &str, language_code: &str) -> bool {
    if voice_name.len() > MAX_VOICE_NAME_BYTES
        || !voice_name.starts_with(language_code)
        || voice_name.as_bytes().get(language_code.len()) != Some(&b'-')
    {
        return false;
    }
    let suffix = &voice_name[language_code.len() + 1..];
    !suffix.is_empty()
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b'_' | b'.'))
        && suffix
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic())
        && suffix
            .bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
}

fn validate_text(text: &str) -> Result<(), AzureSpeechError> {
    if text.trim().is_empty() {
        return Err(AzureSpeechError::InvalidRequest("text is empty"));
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(AzureSpeechError::InvalidRequest("text is too long"));
    }
    if !text.chars().all(valid_xml_character) {
        return Err(AzureSpeechError::InvalidRequest(
            "text contains unsupported characters",
        ));
    }
    Ok(())
}

fn valid_xml_character(character: char) -> bool {
    matches!(character, '\u{9}' | '\u{a}' | '\u{d}')
        || ('\u{20}'..='\u{d7ff}').contains(&character)
        || ('\u{e000}'..='\u{fffd}').contains(&character)
        || ('\u{10000}'..='\u{10ffff}').contains(&character)
}

fn build_ssml(
    text: &str,
    voice_name: &str,
    language_code: &str,
) -> Result<String, AzureSpeechError> {
    // Direct-SSML passthrough. The stock narrator's `NarratorRequest.useDirectSsml`
    // path places a complete `<speak>` envelope directly in the request text
    // field, the `TextToSpeechRequest` wire has no SSML flag to distinguish it
    // from plain text. Escaping and re-wrapping such input double-wraps it, so
    // Azure ends up speaking the literal markup ("speak version 1.0 ..."). Detect
    // a well-formed stock envelope and forward it unchanged, but reject the SSML
    // elements that fetch external resources (`<audio>`, `<lexicon>`, mstts
    // background audio) as a safety bound, since only the envelope shape, not the
    // caller, is trusted.
    let trimmed = text.trim();
    if trimmed.starts_with("<speak") {
        if !trimmed.ends_with("</speak>") {
            return Err(AzureSpeechError::InvalidRequest("malformed SSML envelope"));
        }
        if text.len() > MAX_SSML_BYTES {
            return Err(AzureSpeechError::InvalidRequest("SSML is too long"));
        }
        if !text.chars().all(valid_xml_character) {
            return Err(AzureSpeechError::InvalidRequest(
                "SSML contains unsupported characters",
            ));
        }
        let lowered = trimmed.to_ascii_lowercase();
        if lowered.contains("<audio")
            || lowered.contains("<lexicon")
            || lowered.contains("backgroundaudio")
        {
            return Err(AzureSpeechError::InvalidRequest(
                "SSML external-resource elements are not allowed",
            ));
        }
        return Ok(text.to_string());
    }

    validate_text(text)?;
    if !valid_language_code(language_code) || !valid_voice_name(voice_name, language_code) {
        return Err(AzureSpeechError::NotConfigured);
    }

    let escaped_text = escape_xml(text);
    let escaped_voice = escape_xml(voice_name);
    let escaped_language = escape_xml(language_code);
    let ssml = format!(
        r#"<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="{escaped_language}"><voice name="{escaped_voice}" xml:lang="{escaped_language}">{escaped_text}</voice></speak>"#
    );
    if ssml.len() > MAX_SSML_BYTES {
        return Err(AzureSpeechError::InvalidRequest("SSML is too long"));
    }
    Ok(ssml)
}

fn escape_xml(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::extract::{Request as AxumRequest, State};
    use axum::http::header::LOCATION;
    use axum::response::Response as AxumResponse;
    use axum::routing::any;
    use axum::Router;
    use tokio::net::TcpListener;
    use tokio::sync::Mutex;

    use super::*;

    const TEST_KEY: &str = "0123456789abcdef0123456789abcdef";

    #[derive(Clone)]
    struct MockState {
        status: StatusCode,
        response_body: Arc<Vec<u8>>,
        delay: Duration,
        location: Option<Arc<String>>,
        captured: Arc<Mutex<Option<CapturedRequest>>>,
    }

    struct CapturedRequest;

    async fn mock_speech_handler(
        State(state): State<MockState>,
        request: AxumRequest,
    ) -> AxumResponse {
        let _ = request;
        *state.captured.lock().await = Some(CapturedRequest);

        if !state.delay.is_zero() {
            tokio::time::sleep(state.delay).await;
        }
        let mut response = AxumResponse::builder().status(state.status);
        if let Some(location) = state.location.as_deref() {
            response = response.header(LOCATION, location.as_str());
        }
        response
            .body(Body::from(state.response_body.as_ref().clone()))
            .unwrap()
    }

    async fn spawn_mock_speech(
        status: StatusCode,
        response_body: Vec<u8>,
        delay: Duration,
        location: Option<String>,
    ) -> (String, Arc<Mutex<Option<CapturedRequest>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(None));
        let app = Router::new()
            .fallback(any(mock_speech_handler))
            .with_state(MockState {
                status,
                response_body: Arc::new(response_body),
                delay,
                location: location.map(Arc::new),
                captured: captured.clone(),
            });
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), captured)
    }

    fn configured_options() -> AzureSpeechOptions {
        AzureSpeechOptions::new(
            Some(TEST_KEY.into()),
            Some("westeurope".into()),
            Some("en-US-AvaNeural".into()),
        )
        .with_enabled(true)
        .with_cloud_consent_acknowledged(true)
        .with_connect_timeout(DEFAULT_CONNECT_TIMEOUT)
    }

    fn test_client(base_url: &str, options: AzureSpeechOptions) -> AzureSpeechClient {
        AzureSpeechClient::from_options(options)
            .unwrap()
            .with_test_endpoint(Url::parse(&format!("{base_url}{AZURE_SYNTHESIS_PATH}")).unwrap())
    }

    #[test]
    fn defaults_require_both_gates_and_debug_redacts_the_key() {
        let options =
            AzureSpeechOptions::new(Some(TEST_KEY.into()), None, Some("en-US-AvaNeural".into()));
        assert!(!options.enabled());
        assert!(!options.cloud_consent_acknowledged());
        assert!(options.has_subscription_key());
        assert_eq!(options.region(), None);
        assert_eq!(options.voice_name(), Some("en-US-AvaNeural"));
        assert_eq!(options.language_code(), "en-US");
        assert_eq!(
            options.output_format(),
            AzureSpeechOutputFormat::Riff16Khz16BitMonoPcm
        );

        let rendered = format!("{options:?}");
        assert!(rendered.contains("has_subscription_key: true"));
        assert!(!rendered.contains(TEST_KEY));
        assert!(matches!(
            options.validate(),
            Err(AzureSpeechError::NotConfigured)
        ));

        let disabled = AzureSpeechClient::disabled().unwrap();
        assert!(!disabled.options().enabled());
    }

    #[tokio::test]
    async fn redirect_is_rejected_without_replaying_text_or_key() {
        let (target_base_url, target_capture) =
            spawn_mock_speech(StatusCode::OK, vec![1, 2, 3], Duration::ZERO, None).await;
        let (redirect_base_url, _) = spawn_mock_speech(
            StatusCode::TEMPORARY_REDIRECT,
            Vec::new(),
            Duration::ZERO,
            Some(format!("{target_base_url}/must-not-receive")),
        )
        .await;
        let client = test_client(&redirect_base_url, configured_options());

        assert_eq!(
            client.synthesize("private speech text").await,
            Err(AzureSpeechError::ProviderUnavailable)
        );
        assert!(target_capture.lock().await.is_none());
    }

    #[test]
    fn provider_status_mapping_never_preserves_provider_details() {
        assert_eq!(
            error_for_http_status(StatusCode::BAD_REQUEST),
            AzureSpeechError::BadRequest
        );
        assert_eq!(
            error_for_http_status(StatusCode::PAYLOAD_TOO_LARGE),
            AzureSpeechError::BadRequest
        );
        assert_eq!(
            error_for_http_status(StatusCode::TOO_MANY_REQUESTS),
            AzureSpeechError::RateLimited
        );
        assert_eq!(
            error_for_http_status(StatusCode::UNAUTHORIZED),
            AzureSpeechError::ProviderUnavailable
        );
        assert_eq!(
            error_for_http_status(StatusCode::FORBIDDEN),
            AzureSpeechError::ProviderUnavailable
        );
        assert_eq!(
            error_for_http_status(StatusCode::INTERNAL_SERVER_ERROR),
            AzureSpeechError::ProviderUnavailable
        );
    }
}
