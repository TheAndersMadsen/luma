//! Stock-compatible `humane.aibus.SpeechService` implementation.
//! Stock: ironman/sources/humane/aibus/SpeechServiceGrpc.java
//!
//! Text-to-speech requests are delegated to the privacy-gated Azure Speech
//! client. Request-provided voice names and provider aliases are intentionally
//! ignored: only the operator-configured voice may leave this process.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures::{Stream, StreamExt as _};
use prost::Message as _;
use tokio::sync::RwLock;
use tonic::{Request, Response, Status, Streaming};

use self::transcription::{
    AzureConversationTranscriber, ConversationTranscriber, ConversationTranscriptionError,
    ConversationTranscriptionInput,
};
use self::translation::{
    azure_tts_is_configured, is_supported_locale, is_supported_pair, validate_input_text,
    validate_locale, LlmTranslationProvider, TextTranslationProvider, TranslationInput,
    ValidatedLocale, MAX_TRANSLATION_TEXT_BYTES,
};
use crate::config::ResolvedConfig;
use crate::external::azure_speech::{
    AzureSpeechClient, AzureSpeechError, AzureSpeechOutputFormat, SynthesizedSpeech,
};
use crate::llm::LlmAgent;
use crate::proto::aibus::speech_service_server::SpeechService;
use crate::proto::aibus::{
    Audio, AudioFormat, CanTranslateRequest, CanTranslateResponse, EncryptedCanTranslateRequest,
    EncryptedCanTranslateResponse, EncryptedTranslateConversationRequest,
    EncryptedTranslateConversationResponse, EncryptedTranslateTextRequest,
    EncryptedTranslateTextResponse, SpeechConfig, SpeechSource, TextToSpeechRequest,
    TextToSpeechResponse, TranslateConversationConfig, TranslateConversationRequest,
    TranslateConversationResponse, TranslateTextRequest, TranslateTextResponse,
};
use crate::proto::common::encryption::{EncryptedData, EncryptionInformation};
use crate::tier_a::proto_kids;

mod transcription;
mod translation;

type SpeechResponseStream =
    Pin<Box<dyn Stream<Item = Result<TextToSpeechResponse, Status>> + Send + 'static>>;
type TranslationResponseStream = Pin<
    Box<dyn Stream<Item = Result<EncryptedTranslateConversationResponse, Status>> + Send + 'static>,
>;

// Stock clients use gRPC's default 4 MiB inbound message limit. Keep enough
// headroom for the enclosing Audio and TextToSpeechResponse protobuf fields.
const STOCK_GRPC_DEFAULT_INBOUND_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const UNARY_AUDIO_RESPONSE_BYTES: usize = STOCK_GRPC_DEFAULT_INBOUND_MESSAGE_BYTES - 64;
// Stock forwards every streamed response through ParcelableMessageLite and an
// IStreamObserver Binder transaction. Android's suggested safe IPC ceiling is
// 64 KiB; retain 16 KiB for the protobuf, class name, Parcel, and Binder frame.
const STOCK_BINDER_SUGGESTED_MAX_IPC_BYTES: usize = 64 * 1024;
const STREAMING_AUDIO_CHUNK_BYTES: usize = STOCK_BINDER_SUGGESTED_MAX_IPC_BYTES - 16 * 1024;
const GRPC_TIMEOUT_METADATA_KEY: &str = "grpc-timeout";
const MAX_SPEECH_SYNTHESIS_PROCESSING_TIME: Duration = Duration::from_secs(60);
const CAN_TRANSLATE_REQUEST_KID: &str = proto_kids::CAN_TRANSLATE_REQUEST;
const CAN_TRANSLATE_RESPONSE_KID: &str = proto_kids::CAN_TRANSLATE_RESPONSE;
const TRANSLATE_TEXT_REQUEST_KID: &str = proto_kids::TRANSLATE_TEXT_REQUEST;
const TRANSLATE_TEXT_RESPONSE_KID: &str = proto_kids::TRANSLATE_TEXT_RESPONSE;
const TRANSLATE_CONVERSATION_REQUEST_KID: &str = proto_kids::TRANSLATE_CONVERSATION_REQUEST;
const TRANSLATE_CONVERSATION_RESPONSE_KID: &str = proto_kids::TRANSLATE_CONVERSATION_RESPONSE;
const MAX_CAN_TRANSLATE_REQUEST_BYTES: usize = 512;
const MAX_TRANSLATE_TEXT_REQUEST_BYTES: usize = MAX_TRANSLATION_TEXT_BYTES + 2 * 1024;
const MAX_CONVERSATION_FRAME_BYTES: usize = 128 * 1024;
const MAX_CONVERSATION_AUDIO_BYTES: usize = 30 * 16_000 * 2;
const MAX_CONVERSATION_AUDIO_FRAMES: usize = 8_192;
const MAX_ADDITIONAL_CONVERSATION_LOCALES: usize = 5;
const MAX_CONVERSATION_PROCESSING_TIME: Duration = Duration::from_secs(14);

#[derive(Clone, Default)]
struct TranslationRuntime {
    provider: Option<Arc<dyn TextTranslationProvider>>,
    transcriber: Option<Arc<dyn ConversationTranscriber>>,
    tts_ready: bool,
}

impl TranslationRuntime {
    fn is_ready(&self) -> bool {
        self.tts_ready && self.provider.is_some()
    }
}

#[derive(Clone)]
pub struct SpeechServiceImpl {
    azure_speech: Arc<RwLock<AzureSpeechClient>>,
    translation: Arc<RwLock<TranslationRuntime>>,
}

impl SpeechServiceImpl {
    #[cfg(test)]
    pub fn new(azure_speech: AzureSpeechClient) -> Self {
        Self {
            azure_speech: Arc::new(RwLock::new(azure_speech)),
            translation: Arc::new(RwLock::new(TranslationRuntime::default())),
        }
    }

    /// Construct the stock speech service with the privacy-bounded one-off
    /// translator. Translation remains disabled unless the configured Codex
    /// bridge and the separately consented Azure TTS provider are both ready.
    pub fn new_with_translation(
        azure_speech: AzureSpeechClient,
        agent: Arc<LlmAgent>,
        config: Arc<ResolvedConfig>,
    ) -> Self {
        let provider = LlmTranslationProvider::configured(agent, config.clone());
        let runtime = TranslationRuntime {
            provider,
            transcriber: AzureConversationTranscriber::configured(&config),
            tts_ready: azure_tts_is_configured(&config),
        };
        Self {
            azure_speech: Arc::new(RwLock::new(azure_speech)),
            translation: Arc::new(RwLock::new(runtime)),
        }
    }

    /// Refresh the provider/config gates after a dashboard settings update.
    /// The Azure client is swapped first, so any request racing the update can
    /// only fail closed. No request text or model output is retained in state.
    pub async fn replace_with_translation(
        &self,
        azure_speech: AzureSpeechClient,
        agent: Arc<LlmAgent>,
        config: Arc<ResolvedConfig>,
    ) {
        let runtime = TranslationRuntime {
            provider: LlmTranslationProvider::configured(agent, config.clone()),
            transcriber: AzureConversationTranscriber::configured(&config),
            tts_ready: azure_tts_is_configured(&config),
        };
        *self.azure_speech.write().await = azure_speech;
        *self.translation.write().await = runtime;
    }

    #[cfg(test)]
    fn with_test_translation_provider(
        mut self,
        provider: Arc<dyn TextTranslationProvider>,
        tts_ready: bool,
    ) -> Self {
        self.translation = Arc::new(RwLock::new(TranslationRuntime {
            provider: Some(provider),
            transcriber: None,
            tts_ready,
        }));
        self
    }

    #[cfg(test)]
    fn with_test_conversation_providers(
        mut self,
        provider: Arc<dyn TextTranslationProvider>,
        transcriber: Arc<dyn ConversationTranscriber>,
        tts_ready: bool,
    ) -> Self {
        self.translation = Arc::new(RwLock::new(TranslationRuntime {
            provider: Some(provider),
            transcriber: Some(transcriber),
            tts_ready,
        }));
        self
    }

    async fn synthesize(
        &self,
        request: TextToSpeechRequest,
        maximum_audio_bytes: Option<usize>,
    ) -> Result<TextToSpeechResponse, Status> {
        let audio_format = requested_audio_format(&request)?;
        let azure_format = azure_format(audio_format);

        // Deliberately ignore request.speech_config.voice_name and
        // request.speech_config.speech_source. The configured Azure voice is
        // the sole trusted source for provider-bound voice selection.
        let azure_speech = self.azure_speech.read().await.clone();
        let synthesized = match maximum_audio_bytes {
            Some(maximum_audio_bytes) => {
                azure_speech
                    .synthesize_with_format_bounded(
                        &request.text,
                        azure_format,
                        maximum_audio_bytes,
                    )
                    .await
            }
            None => {
                azure_speech
                    .synthesize_with_format(&request.text, azure_format)
                    .await
            }
        }
        .map_err(status_for_provider_error)?;

        Ok(response_for_speech(synthesized, audio_format))
    }
}

#[tonic::async_trait]
impl SpeechService for SpeechServiceImpl {
    async fn text_to_speech(
        &self,
        request: Request<TextToSpeechRequest>,
    ) -> Result<Response<TextToSpeechResponse>, Status> {
        let timeout = speech_synthesis_request_timeout(&request);
        if timeout.is_zero() {
            return Err(Status::deadline_exceeded("speech synthesis timed out"));
        }

        let response = tokio::time::timeout(
            timeout,
            self.synthesize(request.into_inner(), Some(UNARY_AUDIO_RESPONSE_BYTES)),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("speech synthesis timed out"))??;
        if response.encoded_len() >= STOCK_GRPC_DEFAULT_INBOUND_MESSAGE_BYTES {
            return Err(Status::unavailable("speech synthesis is unavailable"));
        }
        Ok(Response::new(response))
    }

    type StreamingTextToSpeechStream = SpeechResponseStream;

    async fn streaming_text_to_speech(
        &self,
        request: Request<TextToSpeechRequest>,
    ) -> Result<Response<Self::StreamingTextToSpeechStream>, Status> {
        let timeout = speech_synthesis_request_timeout(&request);
        if timeout.is_zero() {
            return Err(Status::deadline_exceeded("speech synthesis timed out"));
        }

        let deadline = tokio::time::Instant::now() + timeout;
        let request = request.into_inner();
        let audio_format = requested_audio_format(&request)?;
        let azure_format = azure_format(audio_format);
        let azure_speech = tokio::time::timeout_at(deadline, self.azure_speech.read())
            .await
            .map_err(|_| Status::deadline_exceeded("speech synthesis timed out"))?
            .clone();
        let mut provider_stream = azure_speech
            .synthesize_stream_with_format(
                &request.text,
                azure_format,
                STREAMING_AUDIO_CHUNK_BYTES,
                deadline,
            )
            .await
            .map_err(status_for_provider_error)?;

        let stream = async_stream::stream! {
            while let Some(provider_result) = provider_stream.next().await {
                match provider_result {
                    Ok(audio) => {
                        yield Ok(response_for_audio(audio.to_vec(), audio_format));
                    }
                    Err(error) => {
                        yield Err(status_for_provider_error(error));
                        break;
                    }
                }
            }
        };
        Ok(Response::new(Box::pin(stream)))
    }

    async fn can_translate(
        &self,
        request: Request<EncryptedCanTranslateRequest>,
    ) -> Result<Response<EncryptedCanTranslateResponse>, Status> {
        let request = request.into_inner();
        let request = CanTranslateRequest::decode(strict_envelope_data(
            &request.data,
            CAN_TRANSLATE_REQUEST_KID,
            MAX_CAN_TRANSLATE_REQUEST_BYTES,
        )?)
        .map_err(|_| Status::invalid_argument("bad CanTranslateRequest"))?;
        let source = request
            .from
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("missing source locale"))
            .and_then(|locale| {
                validate_locale(locale)
                    .map_err(|_| Status::invalid_argument("invalid source locale"))
            })?;
        let target = request
            .to
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("missing target locale"))
            .and_then(|locale| {
                validate_locale(locale)
                    .map_err(|_| Status::invalid_argument("invalid target locale"))
            })?;

        let is_supported =
            self.translation.read().await.is_ready() && is_supported_pair(&source, &target);
        let response = CanTranslateResponse { is_supported };
        Ok(Response::new(EncryptedCanTranslateResponse {
            data: Some(plaintext_envelope(
                CAN_TRANSLATE_RESPONSE_KID,
                response.encode_to_vec(),
            )),
        }))
    }

    async fn translate_text(
        &self,
        request: Request<EncryptedTranslateTextRequest>,
    ) -> Result<Response<EncryptedTranslateTextResponse>, Status> {
        let request = request.into_inner();
        let request = TranslateTextRequest::decode(strict_envelope_data(
            &request.data,
            TRANSLATE_TEXT_REQUEST_KID,
            MAX_TRANSLATE_TEXT_REQUEST_BYTES,
        )?)
        .map_err(|_| Status::invalid_argument("bad TranslateTextRequest"))?;

        // `TranslateAction` is explicitly keyguard-enabled in stock, and its
        // handler legitimately reaches this unary RPC while locked. The lock
        // fields describe device context; they are not an authorization denial
        // for this bounded one-off translation path.
        let text = validate_input_text(&request.text)
            .map_err(|_| Status::invalid_argument("invalid translation text"))?;
        let source = request
            .from
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("missing source locale"))
            .and_then(|locale| {
                validate_locale(locale)
                    .map_err(|_| Status::invalid_argument("invalid source locale"))
            })?;
        let target = request
            .to
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("missing target locale"))
            .and_then(|locale| {
                validate_locale(locale)
                    .map_err(|_| Status::invalid_argument("invalid target locale"))
            })?;
        if !is_supported_pair(&source, &target) {
            return Err(Status::failed_precondition(
                "translation locale pair is unsupported",
            ));
        }

        let speech_config = request
            .speech_config
            .ok_or_else(|| Status::invalid_argument("translation speech is required"))?;
        if speech_config.audio_format != AudioFormat::Riff16khz16bitMonoPcm as i32 {
            return Err(Status::invalid_argument(
                "translation requires RIFF 16 kHz PCM audio",
            ));
        }

        let runtime = self.translation.read().await.clone();
        if !runtime.tts_ready {
            return Err(Status::unavailable("translation is unavailable"));
        }
        let provider = runtime
            .provider
            .ok_or_else(|| Status::unavailable("translation is unavailable"))?;
        let translation = provider
            .translate(&TranslationInput {
                text,
                source,
                target: target.clone(),
            })
            .await
            .map_err(|_| Status::unavailable("translation is unavailable"))?;

        let synthesized = self
            .synthesize(
                TextToSpeechRequest {
                    text: translation.clone(),
                    speech_config: Some(SpeechConfig {
                        audio_format: AudioFormat::Riff16khz16bitMonoPcm as i32,
                        speech_source: SpeechSource::SourceMicrosoftSpeechSynthesis as i32,
                        voice_name: String::new(),
                    }),
                },
                Some(UNARY_AUDIO_RESPONSE_BYTES),
            )
            .await?;
        let speech = synthesized
            .speech
            .filter(|speech| !speech.audio.is_empty())
            .ok_or_else(|| Status::unavailable("translation speech is unavailable"))?;

        let response = TranslateTextResponse {
            translation,
            locale: Some(target.into_proto()),
            speech: Some(speech),
        };
        Ok(Response::new(EncryptedTranslateTextResponse {
            data: Some(plaintext_envelope(
                TRANSLATE_TEXT_RESPONSE_KID,
                response.encode_to_vec(),
            )),
        }))
    }

    type TranslateConversationStream = TranslationResponseStream;

    async fn translate_conversation(
        &self,
        request: Request<Streaming<EncryptedTranslateConversationRequest>>,
    ) -> Result<Response<Self::TranslateConversationStream>, Status> {
        let mut inbound = request.into_inner();
        let service = self.clone();
        let output = async_stream::try_stream! {
            let mut conversation = ConversationAccumulator::default();
            while let Some(frame) = inbound.message().await? {
                conversation.ingest(frame)?;
            }
            let conversation = conversation.finish()?;

            let response = tokio::time::timeout(
                MAX_CONVERSATION_PROCESSING_TIME,
                service.process_conversation(conversation),
            )
            .await
            .map_err(|_| Status::deadline_exceeded("translation processing timed out"))??;
            yield EncryptedTranslateConversationResponse {
                data: Some(plaintext_envelope(
                    TRANSLATE_CONVERSATION_RESPONSE_KID,
                    response.encode_to_vec(),
                )),
            };
        };
        Ok(Response::new(Box::pin(output)))
    }
}

#[derive(Clone)]
struct ValidatedConversationConfig {
    device_locale: ValidatedLocale,
    conversation_locale: ValidatedLocale,
    candidate_locales: Vec<ValidatedLocale>,
    speech_config: Option<SpeechConfig>,
}

struct CompletedConversation {
    config: ValidatedConversationConfig,
    raw_pcm: Vec<u8>,
}

#[derive(Default)]
struct ConversationAccumulator {
    config: Option<ValidatedConversationConfig>,
    raw_pcm: Vec<u8>,
    audio_frames: usize,
}

impl ConversationAccumulator {
    fn ingest(&mut self, frame: EncryptedTranslateConversationRequest) -> Result<(), Status> {
        let frame = TranslateConversationRequest::decode(strict_envelope_data(
            &frame.data,
            TRANSLATE_CONVERSATION_REQUEST_KID,
            MAX_CONVERSATION_FRAME_BYTES,
        )?)
        .map_err(|_| Status::invalid_argument("bad TranslateConversationRequest"))?;

        if self.config.is_none() {
            if frame.audio.is_some() {
                return Err(Status::invalid_argument(
                    "first translation frame must contain only configuration",
                ));
            }
            let config = frame.config.ok_or_else(|| {
                Status::invalid_argument("first translation frame is missing configuration")
            })?;
            self.config = Some(validate_conversation_config(config)?);
            return Ok(());
        }

        if frame.config.is_some() {
            return Err(Status::invalid_argument(
                "translation configuration may only be sent once",
            ));
        }
        let audio = frame
            .audio
            .ok_or_else(|| Status::invalid_argument("translation audio frame is missing audio"))?;
        if audio.format != AudioFormat::Raw16khz16bitMonoPcm as i32 {
            return Err(Status::invalid_argument(
                "translation requires raw 16 kHz mono PCM input",
            ));
        }
        if audio.audio.is_empty() || audio.audio.len() % 2 != 0 {
            return Err(Status::invalid_argument(
                "translation audio frame must contain complete 16-bit samples",
            ));
        }
        self.audio_frames = self
            .audio_frames
            .checked_add(1)
            .ok_or_else(|| Status::resource_exhausted("too many translation audio frames"))?;
        if self.audio_frames > MAX_CONVERSATION_AUDIO_FRAMES {
            return Err(Status::resource_exhausted(
                "too many translation audio frames",
            ));
        }
        let next_length = self
            .raw_pcm
            .len()
            .checked_add(audio.audio.len())
            .ok_or_else(|| Status::resource_exhausted("translation audio is too long"))?;
        if next_length > MAX_CONVERSATION_AUDIO_BYTES {
            return Err(Status::resource_exhausted(
                "translation audio exceeds thirty seconds",
            ));
        }
        self.raw_pcm.extend_from_slice(&audio.audio);
        Ok(())
    }

    fn finish(self) -> Result<CompletedConversation, Status> {
        let config = self
            .config
            .ok_or_else(|| Status::invalid_argument("translation stream has no configuration"))?;
        if self.raw_pcm.is_empty() {
            return Err(Status::invalid_argument("translation stream has no audio"));
        }
        Ok(CompletedConversation {
            config,
            raw_pcm: self.raw_pcm,
        })
    }
}

impl SpeechServiceImpl {
    async fn process_conversation(
        &self,
        conversation: CompletedConversation,
    ) -> Result<TranslateConversationResponse, Status> {
        let runtime = self.translation.read().await.clone();
        let transcriber = runtime
            .transcriber
            .ok_or_else(|| Status::unavailable("conversation transcription is unavailable"))?;
        let provider = runtime
            .provider
            .ok_or_else(|| Status::unavailable("translation is unavailable"))?;

        let transcription = transcriber
            .transcribe(&ConversationTranscriptionInput {
                raw_pcm: conversation.raw_pcm,
                candidate_locales: conversation.config.candidate_locales.clone(),
            })
            .await
            .map_err(status_for_transcription_error)?;
        let target = target_for_detected_locale(&conversation.config, &transcription.locale)?;
        let translation = provider
            .translate(&TranslationInput {
                text: transcription.text.clone(),
                source: transcription.locale.clone(),
                target: target.clone(),
            })
            .await
            .map_err(|_| Status::unavailable("translation is unavailable"))?;

        let speech = if let Some(speech_config) = conversation.config.speech_config {
            if !runtime.tts_ready {
                return Err(Status::unavailable("translation speech is unavailable"));
            }
            let synthesized = self
                .synthesize(
                    TextToSpeechRequest {
                        text: translation.clone(),
                        speech_config: Some(speech_config),
                    },
                    Some(UNARY_AUDIO_RESPONSE_BYTES),
                )
                .await?;
            Some(
                synthesized
                    .speech
                    .filter(|speech| !speech.audio.is_empty())
                    .ok_or_else(|| Status::unavailable("translation speech is unavailable"))?,
            )
        } else {
            None
        };

        Ok(TranslateConversationResponse {
            transcript: transcription.text,
            transcript_locale: Some(transcription.locale.into_proto()),
            translation,
            translation_locale: Some(target.into_proto()),
            speech,
        })
    }
}

fn validate_conversation_config(
    config: TranslateConversationConfig,
) -> Result<ValidatedConversationConfig, Status> {
    let device_locale = config
        .device_locale
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("missing device locale"))
        .and_then(|locale| {
            validate_locale(locale).map_err(|_| Status::invalid_argument("invalid device locale"))
        })?;
    let conversation_locale = config
        .conversation_locale
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("missing conversation locale"))
        .and_then(|locale| {
            validate_locale(locale)
                .map_err(|_| Status::invalid_argument("invalid conversation locale"))
        })?;
    if !is_supported_pair(&device_locale, &conversation_locale) {
        return Err(Status::failed_precondition(
            "translation locale pair is unsupported",
        ));
    }
    if config.additional_conversation_locales.len() > MAX_ADDITIONAL_CONVERSATION_LOCALES {
        return Err(Status::invalid_argument(
            "too many additional conversation locales",
        ));
    }

    let mut candidate_locales = vec![device_locale.clone(), conversation_locale.clone()];
    for locale in &config.additional_conversation_locales {
        let locale = validate_locale(locale)
            .map_err(|_| Status::invalid_argument("invalid additional conversation locale"))?;
        if !is_supported_locale(&locale) {
            return Err(Status::failed_precondition(
                "additional conversation locale is unsupported",
            ));
        }
        if candidate_locales
            .iter()
            .any(|candidate| candidate.language == locale.language)
        {
            return Err(Status::invalid_argument(
                "conversation locales must use unique languages",
            ));
        }
        candidate_locales.push(locale);
    }

    if let Some(speech_config) = config.speech_config.as_ref() {
        AudioFormat::try_from(speech_config.audio_format)
            .map_err(|_| Status::invalid_argument("unsupported translation speech format"))?;
    }

    // Location is deliberately not decrypted, logged, or retained. Stock sends
    // it for cloud personalization, which this bounded translation path does not
    // require.
    Ok(ValidatedConversationConfig {
        device_locale,
        conversation_locale,
        candidate_locales,
        speech_config: config.speech_config,
    })
}

fn target_for_detected_locale(
    config: &ValidatedConversationConfig,
    detected: &ValidatedLocale,
) -> Result<ValidatedLocale, Status> {
    if detected.language == config.device_locale.language {
        return Ok(config.conversation_locale.clone());
    }
    if config
        .candidate_locales
        .iter()
        .skip(1)
        .any(|candidate| candidate.language == detected.language)
    {
        return Ok(config.device_locale.clone());
    }
    Err(Status::failed_precondition(
        "failed to detect a configured translation language",
    ))
}

fn status_for_transcription_error(error: ConversationTranscriptionError) -> Status {
    match error {
        ConversationTranscriptionError::FailedToDetectLanguage => {
            Status::failed_precondition("failed to detect translation language")
        }
        ConversationTranscriptionError::FailedToTranscribe => {
            Status::data_loss("failed to transcribe translation audio")
        }
        ConversationTranscriptionError::Timeout => {
            Status::deadline_exceeded("translation transcription timed out")
        }
        ConversationTranscriptionError::Unavailable => {
            Status::unavailable("conversation transcription is unavailable")
        }
    }
}

fn strict_envelope_data<'a>(
    envelope: &'a Option<EncryptedData>,
    expected_kid: &str,
    maximum_bytes: usize,
) -> Result<&'a [u8], Status> {
    let envelope = envelope
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("missing encrypted data envelope"))?;
    let kid = envelope
        .encryption_information
        .as_ref()
        .map(|information| information.kid.as_str())
        .filter(|kid| !kid.is_empty())
        .ok_or_else(|| Status::invalid_argument("encrypted data envelope missing KID"))?;
    if kid != expected_kid {
        return Err(Status::invalid_argument(format!(
            "encrypted data envelope KID does not match {expected_kid}"
        )));
    }
    if envelope.data.len() > maximum_bytes {
        return Err(Status::invalid_argument(
            "encrypted data payload is too large",
        ));
    }
    Ok(&envelope.data)
}

fn plaintext_envelope(kid: &str, data: Vec<u8>) -> EncryptedData {
    EncryptedData {
        encryption_information: Some(EncryptionInformation { kid: kid.into() }),
        data,
    }
}

fn azure_format(format: AudioFormat) -> AzureSpeechOutputFormat {
    match format {
        AudioFormat::Riff16khz16bitMonoPcm => AzureSpeechOutputFormat::Riff16Khz16BitMonoPcm,
        AudioFormat::Raw16khz16bitMonoPcm => AzureSpeechOutputFormat::Raw16Khz16BitMonoPcm,
        AudioFormat::Raw24khz16bitMonoPcm => AzureSpeechOutputFormat::Raw24Khz16BitMonoPcm,
        AudioFormat::Audio24khz160kbitrateMonoMp3 => {
            AzureSpeechOutputFormat::Audio24Khz160KBitrateMonoMp3
        }
    }
}

fn speech_synthesis_request_timeout<T>(request: &Request<T>) -> Duration {
    request
        .metadata()
        .get(GRPC_TIMEOUT_METADATA_KEY)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_grpc_timeout)
        .unwrap_or(MAX_SPEECH_SYNTHESIS_PROCESSING_TIME)
        .min(MAX_SPEECH_SYNTHESIS_PROCESSING_TIME)
}

/// Parse the gRPC timeout wire format used by Java's `withDeadlineAfter`.
///
/// This intentionally matches Tonic's transport parser: one to eight decimal
/// digits followed by H, M, S, m, u, or n. Invalid metadata is ignored by the
/// normal Tonic server middleware, so callers receive the server ceiling here
/// instead of a new protocol error.
fn parse_grpc_timeout(value: &str) -> Option<Duration> {
    if value.len() < 2 {
        return None;
    }
    let (amount, unit) = value.split_at(value.len() - 1);
    if amount.len() > 8 || !amount.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let amount = amount.parse::<u64>().ok()?;
    match unit {
        "H" => Some(Duration::from_secs(amount * 60 * 60)),
        "M" => Some(Duration::from_secs(amount * 60)),
        "S" => Some(Duration::from_secs(amount)),
        "m" => Some(Duration::from_millis(amount)),
        "u" => Some(Duration::from_micros(amount)),
        "n" => Some(Duration::from_nanos(amount)),
        _ => None,
    }
}

fn response_for_speech(
    synthesized: SynthesizedSpeech,
    audio_format: AudioFormat,
) -> TextToSpeechResponse {
    response_for_audio(synthesized.into_audio(), audio_format)
}

fn response_for_audio(audio: Vec<u8>, audio_format: AudioFormat) -> TextToSpeechResponse {
    TextToSpeechResponse {
        speech: Some(Audio {
            audio,
            format: audio_format as i32,
        }),
        // Azure synthesis does not generate a separate transcription. Avoid
        // duplicating the request text into another response field.
        speech_transcription: String::new(),
        source: SpeechSource::SourceMicrosoftSpeechSynthesis as i32,
    }
}

fn requested_audio_format(request: &TextToSpeechRequest) -> Result<AudioFormat, Status> {
    let requested_format = request
        .speech_config
        .as_ref()
        .map_or(AudioFormat::Riff16khz16bitMonoPcm as i32, |config| {
            config.audio_format
        });
    AudioFormat::try_from(requested_format)
        .map_err(|_| Status::invalid_argument("unsupported speech audio format"))
}

fn status_for_provider_error(error: AzureSpeechError) -> Status {
    match error {
        AzureSpeechError::InvalidRequest(_) => Status::invalid_argument("invalid speech request"),
        AzureSpeechError::Disabled
        | AzureSpeechError::CloudConsentRequired
        | AzureSpeechError::NotConfigured
        | AzureSpeechError::BadRequest
        | AzureSpeechError::RateLimited
        | AzureSpeechError::Transport
        | AzureSpeechError::ProviderUnavailable
        | AzureSpeechError::EmptyResponse
        | AzureSpeechError::ResponseTooLarge => {
            Status::unavailable("speech synthesis is unavailable")
        }
        AzureSpeechError::DeadlineExceeded => {
            Status::deadline_exceeded("speech synthesis timed out")
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use axum::body::{to_bytes, Body};
    use axum::extract::{Request as AxumRequest, State};
    use axum::http::StatusCode as HttpStatusCode;
    use axum::response::Response as AxumResponse;
    use axum::routing::any;
    use axum::Router;
    use futures::StreamExt as _;
    use prost::Message as _;
    use reqwest::Url;
    use tokio::net::TcpListener;
    use tokio::sync::Mutex;
    use tonic::transport::Server;
    use tonic::Code;

    use crate::external::azure_speech::AzureSpeechOptions;
    use crate::proto::aibus::speech_service_client::SpeechServiceClient;
    use crate::proto::aibus::speech_service_server::SpeechServiceServer;
    use crate::proto::aibus::{
        EncryptedTranslateConversationRequest, Locale, SpeechConfig, SynapseSpeechContent,
        TranslateConversationConfig, TranslateConversationRequest, TranslateConversationResponse,
    };
    use crate::proto::common::encryption::EncryptedData;

    use super::transcription::{
        ConversationTranscription, ConversationTranscriptionError, ConversationTranscriptionInput,
    };
    use super::translation::TranslationProviderError;
    use super::*;

    const TEST_KEY: &str = "0123456789abcdef0123456789abcdef";
    const SYNTHESIS_PATH: &str = "/cognitiveservices/v1";

    #[derive(Clone)]
    struct MockState {
        status: HttpStatusCode,
        response_body: Arc<Vec<u8>>,
        delay: Duration,
        captured: Arc<Mutex<Vec<CapturedRequest>>>,
    }

    struct CapturedRequest {
        output_format: Option<String>,
        body: Vec<u8>,
    }

    struct FakeTranslationProvider {
        translation: Result<String, TranslationProviderError>,
        inputs: Arc<Mutex<Vec<TranslationInput>>>,
    }

    struct FakeConversationTranscriber {
        transcription: Result<ConversationTranscription, ConversationTranscriptionError>,
        inputs: Arc<Mutex<Vec<ConversationTranscriptionInput>>>,
    }

    #[tonic::async_trait]
    impl TextTranslationProvider for FakeTranslationProvider {
        async fn translate(
            &self,
            input: &TranslationInput,
        ) -> Result<String, TranslationProviderError> {
            self.inputs.lock().await.push(input.clone());
            self.translation.clone()
        }
    }

    #[tonic::async_trait]
    impl ConversationTranscriber for FakeConversationTranscriber {
        async fn transcribe(
            &self,
            input: &ConversationTranscriptionInput,
        ) -> Result<ConversationTranscription, ConversationTranscriptionError> {
            self.inputs.lock().await.push(input.clone());
            self.transcription.clone()
        }
    }

    async fn mock_speech_handler(
        State(state): State<MockState>,
        request: AxumRequest,
    ) -> AxumResponse {
        let (parts, body) = request.into_parts();
        let body = to_bytes(body, 64 * 1024).await.unwrap().to_vec();
        state.captured.lock().await.push(CapturedRequest {
            output_format: parts
                .headers
                .get("x-microsoft-outputformat")
                .and_then(|value| value.to_str().ok())
                .map(ToString::to_string),
            body,
        });
        if !state.delay.is_zero() {
            tokio::time::sleep(state.delay).await;
        }
        AxumResponse::builder()
            .status(state.status)
            .body(Body::from(state.response_body.as_ref().clone()))
            .unwrap()
    }

    async fn spawn_mock_speech(
        status: HttpStatusCode,
        response_body: Vec<u8>,
    ) -> (Url, Arc<Mutex<Vec<CapturedRequest>>>) {
        spawn_mock_speech_with_delay(status, response_body, Duration::ZERO).await
    }

    async fn spawn_mock_speech_with_delay(
        status: HttpStatusCode,
        response_body: Vec<u8>,
        delay: Duration,
    ) -> (Url, Arc<Mutex<Vec<CapturedRequest>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .fallback(any(mock_speech_handler))
            .with_state(MockState {
                status,
                response_body: Arc::new(response_body),
                delay,
                captured: captured.clone(),
            });
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (
            Url::parse(&format!("http://{address}{SYNTHESIS_PATH}")).unwrap(),
            captured,
        )
    }

    fn configured_client(endpoint: Url) -> AzureSpeechClient {
        let options = AzureSpeechOptions::new(
            Some(TEST_KEY.into()),
            Some("westeurope".into()),
            Some("en-US-AvaNeural".into()),
        )
        .with_enabled(true)
        .with_cloud_consent_acknowledged(true)
        .with_request_timeout(Duration::from_secs(2));
        AzureSpeechClient::from_options(options)
            .unwrap()
            .with_test_endpoint(endpoint)
    }

    fn tts_request(format: i32, voice_name: &str) -> TextToSpeechRequest {
        TextToSpeechRequest {
            text: "private request text".into(),
            speech_config: Some(SpeechConfig {
                audio_format: format,
                speech_source: SpeechSource::SourceGoogleSpeechSynthesis as i32,
                voice_name: voice_name.into(),
            }),
        }
    }

    fn locale(language: &str, country: &str) -> Locale {
        Locale {
            language: language.into(),
            country: country.into(),
        }
    }

    fn encrypted_can_translate(from: Locale, to: Locale) -> EncryptedCanTranslateRequest {
        EncryptedCanTranslateRequest {
            data: Some(plaintext_envelope(
                CAN_TRANSLATE_REQUEST_KID,
                CanTranslateRequest {
                    from: Some(from),
                    to: Some(to),
                }
                .encode_to_vec(),
            )),
        }
    }

    fn encrypted_translate_text(
        text: &str,
        from: Locale,
        to: Locale,
        is_locked: bool,
    ) -> EncryptedTranslateTextRequest {
        EncryptedTranslateTextRequest {
            data: Some(plaintext_envelope(
                TRANSLATE_TEXT_REQUEST_KID,
                TranslateTextRequest {
                    text: text.into(),
                    from: Some(from),
                    to: Some(to),
                    speech_config: Some(SpeechConfig {
                        audio_format: AudioFormat::Riff16khz16bitMonoPcm as i32,
                        speech_source: SpeechSource::SourceUnspecified as i32,
                        voice_name: String::new(),
                    }),
                    is_locked,
                    has_secure_lock: true,
                }
                .encode_to_vec(),
            )),
        }
    }

    fn conversation_config(
        additional_conversation_locales: Vec<Locale>,
        speech_config: Option<SpeechConfig>,
    ) -> TranslateConversationConfig {
        TranslateConversationConfig {
            device_locale: Some(locale("en", "US")),
            conversation_locale: Some(locale("es", "ES")),
            additional_conversation_locales,
            location: None,
            speech_config,
        }
    }

    fn encrypted_conversation_frame(
        config: Option<TranslateConversationConfig>,
        audio: Option<Audio>,
        is_locked: bool,
        has_secure_lock: bool,
    ) -> EncryptedTranslateConversationRequest {
        EncryptedTranslateConversationRequest {
            data: Some(plaintext_envelope(
                TRANSLATE_CONVERSATION_REQUEST_KID,
                TranslateConversationRequest {
                    config,
                    audio,
                    is_locked,
                    has_secure_lock,
                }
                .encode_to_vec(),
            )),
        }
    }

    fn raw_audio_frame(bytes: Vec<u8>) -> EncryptedTranslateConversationRequest {
        encrypted_conversation_frame(
            None,
            Some(Audio {
                audio: bytes,
                format: AudioFormat::Raw16khz16bitMonoPcm as i32,
            }),
            true,
            true,
        )
    }

    #[test]
    fn stock_speech_messages_have_golden_wire_layouts_and_enum_values() {
        let config = SpeechConfig {
            audio_format: AudioFormat::Audio24khz160kbitrateMonoMp3 as i32,
            speech_source: SpeechSource::SourceMicrosoftSpeechSynthesis as i32,
            voice_name: "x".into(),
        };
        assert_eq!(
            config.encode_to_vec(),
            [0x08, 0x03, 0x10, 0x03, 0x1a, 0x01, b'x']
        );

        let request = TextToSpeechRequest {
            text: "x".into(),
            speech_config: Some(config),
        };
        assert_eq!(
            request.encode_to_vec(),
            [0x0a, 0x01, b'x', 0x12, 0x07, 0x08, 0x03, 0x10, 0x03, 0x1a, 0x01, b'x',]
        );

        let speech = Audio {
            audio: vec![0xaa],
            format: AudioFormat::Audio24khz160kbitrateMonoMp3 as i32,
        };
        assert_eq!(speech.encode_to_vec(), [0x0a, 0x01, 0xaa, 0x10, 0x03]);

        let response = TextToSpeechResponse {
            speech: Some(speech.clone()),
            speech_transcription: "x".into(),
            source: SpeechSource::SourceMicrosoftSpeechSynthesis as i32,
        };
        let expected_response = [
            0x0a, 0x05, 0x0a, 0x01, 0xaa, 0x10, 0x03, 0x12, 0x01, b'x', 0x18, 0x03,
        ];
        assert_eq!(response.encode_to_vec(), expected_response);
        assert_eq!(
            SynapseSpeechContent {
                speech: Some(speech),
                speech_transcription: "x".into(),
                source: SpeechSource::SourceMicrosoftSpeechSynthesis as i32,
            }
            .encode_to_vec(),
            expected_response
        );

        let encrypted_data = Some(EncryptedData::default());
        assert_eq!(
            EncryptedCanTranslateRequest {
                data: encrypted_data.clone()
            }
            .encode_to_vec(),
            [0x0a, 0x00]
        );
        assert_eq!(
            EncryptedCanTranslateResponse {
                data: encrypted_data.clone()
            }
            .encode_to_vec(),
            [0x0a, 0x00]
        );
        assert_eq!(
            EncryptedTranslateTextRequest {
                data: encrypted_data.clone()
            }
            .encode_to_vec(),
            [0x0a, 0x00]
        );
        assert_eq!(
            EncryptedTranslateTextResponse {
                data: encrypted_data.clone()
            }
            .encode_to_vec(),
            [0x0a, 0x00]
        );
        assert_eq!(
            EncryptedTranslateConversationRequest {
                data: encrypted_data.clone()
            }
            .encode_to_vec(),
            [0x0a, 0x00]
        );
        assert_eq!(
            EncryptedTranslateConversationResponse {
                data: encrypted_data
            }
            .encode_to_vec(),
            [0x0a, 0x00]
        );

        assert_eq!(AudioFormat::Riff16khz16bitMonoPcm as i32, 0);
        assert_eq!(AudioFormat::Raw16khz16bitMonoPcm as i32, 1);
        assert_eq!(AudioFormat::Raw24khz16bitMonoPcm as i32, 2);
        assert_eq!(AudioFormat::Audio24khz160kbitrateMonoMp3 as i32, 3);
        assert_eq!(SpeechSource::SourceMicrosoftSpeechSynthesis as i32, 3);
        assert_eq!(
            <SpeechServiceServer<SpeechServiceImpl> as tonic::server::NamedService>::NAME,
            "humane.aibus.SpeechService"
        );

        let en_us = locale("en", "US");
        let es_es = locale("es", "ES");
        assert_eq!(
            en_us.encode_to_vec(),
            [0x0a, 0x02, b'e', b'n', 0x12, 0x02, b'U', b'S']
        );
        assert_eq!(
            CanTranslateRequest {
                from: Some(en_us.clone()),
                to: Some(es_es.clone()),
            }
            .encode_to_vec(),
            [
                0x0a, 0x08, 0x0a, 0x02, b'e', b'n', 0x12, 0x02, b'U', b'S', 0x12, 0x08, 0x0a, 0x02,
                b'e', b's', 0x12, 0x02, b'E', b'S',
            ]
        );
        assert_eq!(
            CanTranslateResponse { is_supported: true }.encode_to_vec(),
            [0x08, 0x01]
        );
        assert_eq!(
            TranslateTextRequest {
                text: "x".into(),
                from: Some(en_us),
                to: Some(es_es.clone()),
                speech_config: Some(SpeechConfig::default()),
                is_locked: true,
                has_secure_lock: true,
            }
            .encode_to_vec(),
            [
                0x0a, 0x01, b'x', 0x12, 0x08, 0x0a, 0x02, b'e', b'n', 0x12, 0x02, b'U', b'S', 0x1a,
                0x08, 0x0a, 0x02, b'e', b's', 0x12, 0x02, b'E', b'S', 0x22, 0x00, 0x28, 0x01, 0x30,
                0x01,
            ]
        );
        assert_eq!(
            TranslateTextResponse {
                translation: "x".into(),
                locale: Some(es_es),
                speech: Some(Audio {
                    audio: vec![0xaa],
                    format: AudioFormat::Riff16khz16bitMonoPcm as i32,
                }),
            }
            .encode_to_vec(),
            [
                0x0a, 0x01, b'x', 0x12, 0x08, 0x0a, 0x02, b'e', b's', 0x12, 0x02, b'E', b'S', 0x1a,
                0x03, 0x0a, 0x01, 0xaa,
            ]
        );

        let conversation_config =
            conversation_config(vec![locale("fr", "FR")], Some(SpeechConfig::default()));
        assert_eq!(
            conversation_config.encode_to_vec(),
            [
                0x0a, 0x08, 0x0a, 0x02, b'e', b'n', 0x12, 0x02, b'U', b'S', 0x12, 0x08, 0x0a, 0x02,
                b'e', b's', 0x12, 0x02, b'E', b'S', 0x1a, 0x08, 0x0a, 0x02, b'f', b'r', 0x12, 0x02,
                b'F', b'R', 0x2a, 0x00,
            ]
        );
        assert_eq!(
            TranslateConversationRequest {
                config: Some(conversation_config),
                audio: None,
                is_locked: true,
                has_secure_lock: true,
            }
            .encode_to_vec(),
            [
                0x0a, 0x20, 0x0a, 0x08, 0x0a, 0x02, b'e', b'n', 0x12, 0x02, b'U', b'S', 0x12, 0x08,
                0x0a, 0x02, b'e', b's', 0x12, 0x02, b'E', b'S', 0x1a, 0x08, 0x0a, 0x02, b'f', b'r',
                0x12, 0x02, b'F', b'R', 0x2a, 0x00, 0x18, 0x01, 0x20, 0x01,
            ]
        );
        assert_eq!(
            TranslateConversationResponse {
                transcript: "x".into(),
                transcript_locale: Some(locale("en", "US")),
                translation: "y".into(),
                translation_locale: Some(locale("es", "ES")),
                speech: Some(Audio {
                    audio: vec![0xaa],
                    format: AudioFormat::Riff16khz16bitMonoPcm as i32,
                }),
            }
            .encode_to_vec(),
            [
                0x0a, 0x01, b'x', 0x12, 0x08, 0x0a, 0x02, b'e', b'n', 0x12, 0x02, b'U', b'S', 0x1a,
                0x01, b'y', 0x22, 0x08, 0x0a, 0x02, b'e', b's', 0x12, 0x02, b'E', b'S', 0x2a, 0x03,
                0x0a, 0x01, 0xaa,
            ]
        );
    }

    #[test]
    fn speech_timeout_parser_matches_grpc_wire_units_and_applies_server_ceiling() {
        assert_eq!(parse_grpc_timeout("1H"), Some(Duration::from_secs(3_600)));
        assert_eq!(parse_grpc_timeout("2M"), Some(Duration::from_secs(120)));
        assert_eq!(parse_grpc_timeout("3S"), Some(Duration::from_secs(3)));
        assert_eq!(parse_grpc_timeout("4m"), Some(Duration::from_millis(4)));
        assert_eq!(parse_grpc_timeout("5u"), Some(Duration::from_micros(5)));
        assert_eq!(parse_grpc_timeout("6n"), Some(Duration::from_nanos(6)));
        for invalid in ["", "n", "1", "-1S", "1x", "123456789n"] {
            assert_eq!(parse_grpc_timeout(invalid), None, "accepted {invalid:?}");
        }

        let mut stock_request = Request::new(());
        stock_request.set_timeout(Duration::from_millis(3_750));
        assert_eq!(
            speech_synthesis_request_timeout(&stock_request),
            Duration::from_millis(3_750)
        );

        let mut excessive = Request::new(());
        excessive
            .metadata_mut()
            .insert(GRPC_TIMEOUT_METADATA_KEY, "61S".parse().unwrap());
        assert_eq!(
            speech_synthesis_request_timeout(&excessive),
            MAX_SPEECH_SYNTHESIS_PROCESSING_TIME
        );

        let mut malformed = Request::new(());
        malformed
            .metadata_mut()
            .insert(GRPC_TIMEOUT_METADATA_KEY, "not-a-timeout".parse().unwrap());
        assert_eq!(
            speech_synthesis_request_timeout(&malformed),
            MAX_SPEECH_SYNTHESIS_PROCESSING_TIME
        );
        assert_eq!(
            speech_synthesis_request_timeout(&Request::new(())),
            MAX_SPEECH_SYNTHESIS_PROCESSING_TIME
        );
    }

    #[tokio::test]
    async fn unary_tts_honors_zero_and_positive_deadlines_without_waiting_for_provider_timeout() {
        let (endpoint, captured) =
            spawn_mock_speech_with_delay(HttpStatusCode::OK, vec![1, 2, 3], Duration::from_secs(1))
                .await;
        let service = SpeechServiceImpl::new(configured_client(endpoint));

        let mut expired = Request::new(tts_request(
            AudioFormat::Riff16khz16bitMonoPcm as i32,
            "ignored",
        ));
        expired
            .metadata_mut()
            .insert(GRPC_TIMEOUT_METADATA_KEY, "0n".parse().unwrap());
        let expired_error = SpeechService::text_to_speech(&service, expired)
            .await
            .unwrap_err();
        assert_eq!(expired_error.code(), Code::DeadlineExceeded);
        assert_eq!(expired_error.message(), "speech synthesis timed out");
        assert!(captured.lock().await.is_empty());

        let mut bounded = Request::new(tts_request(
            AudioFormat::Riff16khz16bitMonoPcm as i32,
            "ignored",
        ));
        bounded.set_timeout(Duration::from_millis(100));
        let started = std::time::Instant::now();
        let bounded_error = SpeechService::text_to_speech(&service, bounded)
            .await
            .unwrap_err();
        assert_eq!(bounded_error.code(), Code::DeadlineExceeded);
        assert_eq!(bounded_error.message(), "speech synthesis timed out");
        assert!(started.elapsed() < Duration::from_millis(750));
        assert_eq!(captured.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn streaming_tts_honors_zero_and_positive_deadlines_before_emitting_audio() {
        let (endpoint, captured) =
            spawn_mock_speech_with_delay(HttpStatusCode::OK, vec![1, 2, 3], Duration::from_secs(1))
                .await;
        let service = SpeechServiceImpl::new(configured_client(endpoint));

        let mut expired = Request::new(tts_request(
            AudioFormat::Raw24khz16bitMonoPcm as i32,
            "ignored",
        ));
        expired
            .metadata_mut()
            .insert(GRPC_TIMEOUT_METADATA_KEY, "0n".parse().unwrap());
        let expired_error = SpeechService::streaming_text_to_speech(&service, expired)
            .await
            .err()
            .expect("expired streaming synthesis unexpectedly succeeded");
        assert_eq!(expired_error.code(), Code::DeadlineExceeded);
        assert_eq!(expired_error.message(), "speech synthesis timed out");
        assert!(captured.lock().await.is_empty());

        let mut bounded = Request::new(tts_request(
            AudioFormat::Raw24khz16bitMonoPcm as i32,
            "ignored",
        ));
        bounded.set_timeout(Duration::from_millis(100));
        let started = std::time::Instant::now();
        let bounded_error = SpeechService::streaming_text_to_speech(&service, bounded)
            .await
            .err()
            .expect("bounded streaming synthesis unexpectedly succeeded");
        assert_eq!(bounded_error.code(), Code::DeadlineExceeded);
        assert_eq!(bounded_error.message(), "speech synthesis timed out");
        assert!(started.elapsed() < Duration::from_millis(750));
        assert_eq!(captured.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn unary_tts_rejects_audio_that_stock_grpc_clients_cannot_receive() {
        let largest_safe_response = TextToSpeechResponse {
            speech: Some(Audio {
                audio: vec![0; UNARY_AUDIO_RESPONSE_BYTES],
                format: AudioFormat::Audio24khz160kbitrateMonoMp3 as i32,
            }),
            speech_transcription: String::new(),
            source: SpeechSource::SourceMicrosoftSpeechSynthesis as i32,
        };
        assert!(largest_safe_response.encoded_len() < STOCK_GRPC_DEFAULT_INBOUND_MESSAGE_BYTES);

        let (endpoint, captured) = spawn_mock_speech(
            HttpStatusCode::OK,
            vec![0x55; UNARY_AUDIO_RESPONSE_BYTES + 1],
        )
        .await;
        let service = SpeechServiceImpl::new(configured_client(endpoint));
        let error = SpeechService::text_to_speech(
            &service,
            Request::new(tts_request(
                AudioFormat::Audio24khz160kbitrateMonoMp3 as i32,
                "ignored",
            )),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code(), Code::Unavailable);
        assert_eq!(error.message(), "speech synthesis is unavailable");
        assert_eq!(captured.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn unary_and_streaming_tts_map_format_source_and_use_only_configured_voice() {
        let (endpoint, captured) =
            spawn_mock_speech(HttpStatusCode::OK, vec![0x52, 0x49, 0x46, 0x46]).await;
        let service = SpeechServiceImpl::new(configured_client(endpoint));
        let requested_format = AudioFormat::Audio24khz160kbitrateMonoMp3 as i32;
        let untrusted_voice = "untrusted-voice-alias";

        let unary = SpeechService::text_to_speech(
            &service,
            Request::new(tts_request(requested_format, untrusted_voice)),
        )
        .await
        .unwrap()
        .into_inner();
        assert_eq!(
            unary.source,
            SpeechSource::SourceMicrosoftSpeechSynthesis as i32
        );
        assert!(unary.speech_transcription.is_empty());
        assert_eq!(unary.speech.unwrap().format, requested_format);

        let mut streaming = SpeechService::streaming_text_to_speech(
            &service,
            Request::new(tts_request(requested_format, untrusted_voice)),
        )
        .await
        .unwrap()
        .into_inner();
        let streamed = streaming.next().await.unwrap().unwrap();
        assert_eq!(
            streamed.source,
            SpeechSource::SourceMicrosoftSpeechSynthesis as i32
        );
        assert!(streamed.encoded_len() < STOCK_GRPC_DEFAULT_INBOUND_MESSAGE_BYTES);
        let streamed_speech = streamed.speech.unwrap();
        assert_eq!(streamed_speech.audio, [0x52, 0x49, 0x46, 0x46]);
        assert_eq!(streamed_speech.format, requested_format);
        assert!(streaming.next().await.is_none());

        let captured = captured.lock().await;
        assert_eq!(captured.len(), 2);
        for request in captured.iter() {
            assert_eq!(
                request.output_format.as_deref(),
                Some("audio-24khz-160kbitrate-mono-mp3")
            );
            let ssml = String::from_utf8_lossy(&request.body);
            assert!(ssml.contains("en-US-AvaNeural"));
            assert!(!ssml.contains(untrusted_voice));
        }
    }

    #[tokio::test]
    async fn streaming_tts_splits_large_audio_into_ordered_grpc_safe_messages() {
        let expected_audio = (0..(2 * STREAMING_AUDIO_CHUNK_BYTES + 17))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let (endpoint, _) = spawn_mock_speech(HttpStatusCode::OK, expected_audio.clone()).await;
        let service = SpeechServiceImpl::new(configured_client(endpoint));
        let requested_format = AudioFormat::Raw24khz16bitMonoPcm as i32;

        let mut streaming = SpeechService::streaming_text_to_speech(
            &service,
            Request::new(tts_request(requested_format, "ignored")),
        )
        .await
        .unwrap()
        .into_inner();
        let mut responses = Vec::new();
        while let Some(response) = streaming.next().await {
            responses.push(response.unwrap());
        }

        assert!(
            responses.len() >= 3,
            "expected at least 3 chunks, got {}",
            responses.len()
        );
        assert!(responses
            .iter()
            .all(|response| response.encoded_len() < STOCK_GRPC_DEFAULT_INBOUND_MESSAGE_BYTES));
        assert!(responses
            .iter()
            .all(|response| response.encoded_len() < STOCK_BINDER_SUGGESTED_MAX_IPC_BYTES));
        assert!(responses.iter().all(|response| {
            response.source == SpeechSource::SourceMicrosoftSpeechSynthesis as i32
                && response.speech_transcription.is_empty()
                && response
                    .speech
                    .as_ref()
                    .is_some_and(|speech| speech.format == requested_format)
        }));

        let chunk_lengths = responses
            .iter()
            .map(|response| response.speech.as_ref().unwrap().audio.len())
            .collect::<Vec<_>>();
        eprintln!("Chunk lengths: {:?}", chunk_lengths);
        // Verify all chunks are within size limits and total is correct
        assert!(
            chunk_lengths
                .iter()
                .all(|&len| len <= STREAMING_AUDIO_CHUNK_BYTES),
            "chunk exceeds limit: {:?}",
            chunk_lengths
        );
        assert_eq!(
            chunk_lengths.iter().sum::<usize>(),
            expected_audio.len(),
            "total chunk size mismatch"
        );
        assert!(chunk_lengths.iter().all(|length| *length > 0));

        let reconstructed_audio = responses
            .iter()
            .flat_map(|response| response.speech.as_ref().unwrap().audio.iter().copied())
            .collect::<Vec<_>>();
        assert_eq!(reconstructed_audio, expected_audio);
    }

    #[tokio::test]
    async fn disabled_invalid_and_provider_auth_failures_return_fallback_safe_statuses() {
        let disabled = SpeechServiceImpl::new(AzureSpeechClient::disabled().unwrap());
        let disabled_error = SpeechService::text_to_speech(
            &disabled,
            Request::new(tts_request(
                AudioFormat::Riff16khz16bitMonoPcm as i32,
                "ignored",
            )),
        )
        .await
        .unwrap_err();
        assert_eq!(disabled_error.code(), Code::Unavailable);
        assert_eq!(disabled_error.message(), "speech synthesis is unavailable");
        let disabled_streaming_error = SpeechService::streaming_text_to_speech(
            &disabled,
            Request::new(tts_request(
                AudioFormat::Riff16khz16bitMonoPcm as i32,
                "ignored",
            )),
        )
        .await
        .err()
        .expect("disabled streaming synthesis unexpectedly succeeded");
        assert_eq!(disabled_streaming_error.code(), Code::Unavailable);
        assert_eq!(
            disabled_streaming_error.message(),
            "speech synthesis is unavailable"
        );

        let invalid_format =
            SpeechService::text_to_speech(&disabled, Request::new(tts_request(99, "ignored")))
                .await
                .unwrap_err();
        assert_eq!(invalid_format.code(), Code::InvalidArgument);
        let invalid_streaming_format = SpeechService::streaming_text_to_speech(
            &disabled,
            Request::new(tts_request(99, "ignored")),
        )
        .await
        .err()
        .expect("invalid streaming format unexpectedly succeeded");
        assert_eq!(invalid_streaming_format.code(), Code::InvalidArgument);

        let (endpoint, _) = spawn_mock_speech(
            HttpStatusCode::UNAUTHORIZED,
            b"provider-body-must-never-appear".to_vec(),
        )
        .await;
        let service = SpeechServiceImpl::new(configured_client(endpoint));
        let auth_error = SpeechService::text_to_speech(
            &service,
            Request::new(tts_request(
                AudioFormat::Riff16khz16bitMonoPcm as i32,
                "secret-request-voice",
            )),
        )
        .await
        .unwrap_err();
        assert_eq!(auth_error.code(), Code::Unavailable);
        let streaming_auth_error = SpeechService::streaming_text_to_speech(
            &service,
            Request::new(tts_request(
                AudioFormat::Riff16khz16bitMonoPcm as i32,
                "secret-request-voice",
            )),
        )
        .await
        .err()
        .expect("unauthorized streaming synthesis unexpectedly succeeded");
        assert_eq!(streaming_auth_error.code(), Code::Unavailable);
        let rendered =
            format!("{auth_error:?} {auth_error} {streaming_auth_error:?} {streaming_auth_error}");
        assert!(!rendered.contains("provider-body-must-never-appear"));
        assert!(!rendered.contains("private request text"));
        assert!(!rendered.contains("secret-request-voice"));
    }

    #[tokio::test]
    async fn input_size_limit_and_unconfigured_translation_fail_closed() {
        let (endpoint, captured) = spawn_mock_speech(HttpStatusCode::OK, vec![1]).await;
        let service = SpeechServiceImpl::new(configured_client(endpoint));
        let oversized = TextToSpeechRequest {
            text: "x".repeat(8 * 1024 + 1),
            speech_config: None,
        };
        let size_error = SpeechService::text_to_speech(&service, Request::new(oversized))
            .await
            .unwrap_err();
        assert_eq!(size_error.code(), Code::InvalidArgument);
        assert!(captured.lock().await.is_empty());

        let can_translate = SpeechService::can_translate(
            &service,
            Request::new(encrypted_can_translate(
                locale("en", "US"),
                locale("es", "ES"),
            )),
        )
        .await
        .unwrap()
        .into_inner()
        .data
        .unwrap();
        assert_eq!(
            can_translate.encryption_information.unwrap().kid,
            CAN_TRANSLATE_RESPONSE_KID
        );
        assert!(
            !CanTranslateResponse::decode(can_translate.data.as_slice())
                .unwrap()
                .is_supported
        );

        let translate_text = SpeechService::translate_text(
            &service,
            Request::new(encrypted_translate_text(
                "hello",
                locale("en", "US"),
                locale("es", "ES"),
                false,
            )),
        )
        .await
        .unwrap_err();
        assert_eq!(translate_text.code(), Code::Unavailable);

        let malformed = SpeechService::can_translate(
            &service,
            Request::new(EncryptedCanTranslateRequest::default()),
        )
        .await
        .unwrap_err();
        assert_eq!(malformed.code(), Code::InvalidArgument);
    }

    #[tokio::test]
    async fn one_off_translation_returns_exact_text_locale_and_riff_audio_while_locked() {
        let riff = vec![0x52, 0x49, 0x46, 0x46, 0x01, 0x02];
        let (endpoint, captured_speech) = spawn_mock_speech(HttpStatusCode::OK, riff.clone()).await;
        let inputs = Arc::new(Mutex::new(Vec::new()));
        let provider = Arc::new(FakeTranslationProvider {
            translation: Ok("Hola mundo".into()),
            inputs: inputs.clone(),
        });
        let service = SpeechServiceImpl::new(configured_client(endpoint))
            .with_test_translation_provider(provider, true);

        let can_translate = SpeechService::can_translate(
            &service,
            Request::new(encrypted_can_translate(
                locale("en", "US"),
                locale("es", "ES"),
            )),
        )
        .await
        .unwrap()
        .into_inner()
        .data
        .unwrap();
        assert!(
            CanTranslateResponse::decode(can_translate.data.as_slice())
                .unwrap()
                .is_supported
        );

        let response = SpeechService::translate_text(
            &service,
            Request::new(encrypted_translate_text(
                "Hello world",
                locale("en", "US"),
                locale("es", "ES"),
                true,
            )),
        )
        .await
        .unwrap()
        .into_inner()
        .data
        .unwrap();
        assert_eq!(
            response.encryption_information.unwrap().kid,
            TRANSLATE_TEXT_RESPONSE_KID
        );
        let response = TranslateTextResponse::decode(response.data.as_slice()).unwrap();
        assert_eq!(response.translation, "Hola mundo");
        assert_eq!(response.locale, Some(locale("es", "ES")));
        let speech = response.speech.unwrap();
        assert_eq!(speech.format, AudioFormat::Riff16khz16bitMonoPcm as i32);
        assert_eq!(speech.audio, riff);

        let inputs = inputs.lock().await;
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].text, "Hello world");
        assert_eq!(inputs[0].source.tag(), "en-US");
        assert_eq!(inputs[0].target.tag(), "es-ES");
        drop(inputs);

        let captured_speech = captured_speech.lock().await;
        assert_eq!(captured_speech.len(), 1);
        assert_eq!(
            captured_speech[0].output_format.as_deref(),
            Some("riff-16khz-16bit-mono-pcm")
        );
        let ssml = String::from_utf8_lossy(&captured_speech[0].body);
        assert!(ssml.contains("Hola mundo"));
        assert!(!ssml.contains("Hello world"));
    }

    #[tokio::test]
    async fn invalid_and_failed_translation_never_reach_tts() {
        let (endpoint, captured_speech) = spawn_mock_speech(HttpStatusCode::OK, vec![1]).await;
        let inputs = Arc::new(Mutex::new(Vec::new()));
        let provider = Arc::new(FakeTranslationProvider {
            translation: Err(TranslationProviderError::Unavailable),
            inputs: inputs.clone(),
        });
        let service = SpeechServiceImpl::new(configured_client(endpoint))
            .with_test_translation_provider(provider, true);

        let failed = SpeechService::translate_text(
            &service,
            Request::new(encrypted_translate_text(
                "ordinary words",
                locale("en", "US"),
                locale("es", "ES"),
                false,
            )),
        )
        .await
        .unwrap_err();
        assert_eq!(failed.code(), Code::Unavailable);
        assert_eq!(inputs.lock().await.len(), 1);
        assert!(captured_speech.lock().await.is_empty());

        let invalid_locale = SpeechService::can_translate(
            &service,
            Request::new(encrypted_can_translate(
                locale("en-US", ""),
                locale("es", "ES"),
            )),
        )
        .await
        .unwrap_err();
        assert_eq!(invalid_locale.code(), Code::InvalidArgument);

        let mut wrong_kid = encrypted_can_translate(locale("en", "US"), locale("es", "ES"));
        wrong_kid
            .data
            .as_mut()
            .unwrap()
            .encryption_information
            .as_mut()
            .unwrap()
            .kid = proto_kids::TRANSLATE_TEXT_REQUEST.into();
        let wrong_kid = SpeechService::can_translate(&service, Request::new(wrong_kid))
            .await
            .unwrap_err();
        assert_eq!(wrong_kid.code(), Code::InvalidArgument);
    }

    #[tokio::test]
    async fn translate_text_fails_closed_when_synthesized_audio_exceeds_unary_grpc_limit() {
        let (endpoint, captured_speech) = spawn_mock_speech(
            HttpStatusCode::OK,
            vec![0x52; UNARY_AUDIO_RESPONSE_BYTES + 1],
        )
        .await;
        let inputs = Arc::new(Mutex::new(Vec::new()));
        let provider = Arc::new(FakeTranslationProvider {
            translation: Ok("Hola".into()),
            inputs: inputs.clone(),
        });
        let service = SpeechServiceImpl::new(configured_client(endpoint))
            .with_test_translation_provider(provider, true);

        let error = SpeechService::translate_text(
            &service,
            Request::new(encrypted_translate_text(
                "Hello",
                locale("en", "US"),
                locale("es", "ES"),
                false,
            )),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code(), Code::Unavailable);
        assert_eq!(error.message(), "speech synthesis is unavailable");
        let inputs = inputs.lock().await;
        assert_eq!(inputs.len(), 1);
        drop(inputs);
        assert_eq!(captured_speech.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn can_translate_requires_the_independent_tts_readiness_gate() {
        let (endpoint, captured_speech) = spawn_mock_speech(HttpStatusCode::OK, vec![1]).await;
        let inputs = Arc::new(Mutex::new(Vec::new()));
        let provider = Arc::new(FakeTranslationProvider {
            translation: Ok("Hola".into()),
            inputs: inputs.clone(),
        });
        let service = SpeechServiceImpl::new(configured_client(endpoint))
            .with_test_translation_provider(provider, false);

        let response = SpeechService::can_translate(
            &service,
            Request::new(encrypted_can_translate(
                locale("en", "US"),
                locale("es", "ES"),
            )),
        )
        .await
        .unwrap()
        .into_inner()
        .data
        .unwrap();
        assert!(
            !CanTranslateResponse::decode(response.data.as_slice())
                .unwrap()
                .is_supported
        );

        let unavailable = SpeechService::translate_text(
            &service,
            Request::new(encrypted_translate_text(
                "hello",
                locale("en", "US"),
                locale("es", "ES"),
                false,
            )),
        )
        .await
        .unwrap_err();
        assert_eq!(unavailable.code(), Code::Unavailable);
        assert!(inputs.lock().await.is_empty());
        assert!(captured_speech.lock().await.is_empty());
    }

    #[test]
    fn conversation_stream_requires_config_then_bounded_raw_pcm_and_half_close() {
        let config = encrypted_conversation_frame(
            Some(conversation_config(Vec::new(), None)),
            None,
            true,
            true,
        );

        let mut conversation = ConversationAccumulator::default();
        conversation.ingest(config.clone()).unwrap();
        conversation
            .ingest(raw_audio_frame(vec![0x00, 0x01, 0x02, 0x03]))
            .unwrap();
        let completed = conversation.finish().unwrap();
        assert_eq!(completed.raw_pcm, [0x00, 0x01, 0x02, 0x03]);
        assert_eq!(completed.config.candidate_locales.len(), 2);

        let mut missing_config = ConversationAccumulator::default();
        assert_eq!(
            missing_config
                .ingest(raw_audio_frame(vec![0x00, 0x01]))
                .unwrap_err()
                .code(),
            Code::InvalidArgument
        );

        let mut duplicate_config = ConversationAccumulator::default();
        duplicate_config.ingest(config.clone()).unwrap();
        assert_eq!(
            duplicate_config.ingest(config).unwrap_err().code(),
            Code::InvalidArgument
        );

        let mut odd_sample = ConversationAccumulator::default();
        odd_sample
            .ingest(encrypted_conversation_frame(
                Some(conversation_config(Vec::new(), None)),
                None,
                false,
                false,
            ))
            .unwrap();
        assert_eq!(
            odd_sample
                .ingest(encrypted_conversation_frame(
                    None,
                    Some(Audio {
                        audio: vec![0x00],
                        format: AudioFormat::Raw16khz16bitMonoPcm as i32,
                    }),
                    false,
                    false,
                ))
                .unwrap_err()
                .code(),
            Code::InvalidArgument
        );

        let mut no_audio = ConversationAccumulator::default();
        no_audio
            .ingest(encrypted_conversation_frame(
                Some(conversation_config(Vec::new(), None)),
                None,
                false,
                false,
            ))
            .unwrap();
        let no_audio = match no_audio.finish() {
            Ok(_) => panic!("empty conversation unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(no_audio.code(), Code::InvalidArgument);
    }

    #[test]
    fn conversation_config_allows_at_most_five_unique_additional_locales() {
        let five = vec![
            locale("fr", "FR"),
            locale("it", "IT"),
            locale("pt", "PT"),
            locale("de", "DE"),
            locale("en", "GB"),
        ];
        // The fifth entry duplicates the device language and is rejected even
        // though the count itself is stock-valid.
        let duplicate = match validate_conversation_config(conversation_config(five, None)) {
            Ok(_) => panic!("duplicate conversation language unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(duplicate.code(), Code::InvalidArgument);

        let too_many = match validate_conversation_config(conversation_config(
            vec![
                locale("fr", "FR"),
                locale("it", "IT"),
                locale("pt", "PT"),
                locale("de", "DE"),
                locale("fr", "CA"),
                locale("it", "CH"),
            ],
            None,
        )) {
            Ok(_) => panic!("too many conversation locales unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(too_many.code(), Code::InvalidArgument);

        let four = validate_conversation_config(conversation_config(
            vec![
                locale("fr", "FR"),
                locale("it", "IT"),
                locale("pt", "PT"),
                locale("de", "DE"),
            ],
            None,
        ))
        .unwrap();
        assert_eq!(four.candidate_locales.len(), 6);
    }

    #[test]
    fn conversation_audio_is_capped_at_thirty_seconds() {
        let mut conversation = ConversationAccumulator::default();
        conversation
            .ingest(encrypted_conversation_frame(
                Some(conversation_config(Vec::new(), None)),
                None,
                true,
                true,
            ))
            .unwrap();
        let chunk_bytes = 120_000;
        for _ in 0..(MAX_CONVERSATION_AUDIO_BYTES / chunk_bytes) {
            conversation
                .ingest(raw_audio_frame(vec![0; chunk_bytes]))
                .unwrap();
        }
        assert_eq!(conversation.raw_pcm.len(), MAX_CONVERSATION_AUDIO_BYTES);
        assert_eq!(
            conversation
                .ingest(raw_audio_frame(vec![0, 0]))
                .unwrap_err()
                .code(),
            Code::ResourceExhausted
        );
    }

    #[test]
    fn conversation_audio_frame_count_is_bounded_even_for_tiny_frames() {
        let mut conversation = ConversationAccumulator::default();
        conversation
            .ingest(encrypted_conversation_frame(
                Some(conversation_config(Vec::new(), None)),
                None,
                true,
                true,
            ))
            .unwrap();
        for _ in 0..MAX_CONVERSATION_AUDIO_FRAMES {
            conversation.ingest(raw_audio_frame(vec![0, 0])).unwrap();
        }
        assert_eq!(
            conversation
                .ingest(raw_audio_frame(vec![0, 0]))
                .unwrap_err()
                .code(),
            Code::ResourceExhausted
        );
    }

    #[tokio::test]
    async fn conversation_detects_direction_translates_and_synthesizes_one_final_payload() {
        let riff = vec![0x52, 0x49, 0x46, 0x46, 0x01, 0x02];
        let (endpoint, captured_speech) = spawn_mock_speech(HttpStatusCode::OK, riff.clone()).await;
        let translation_inputs = Arc::new(Mutex::new(Vec::new()));
        let transcription_inputs = Arc::new(Mutex::new(Vec::new()));
        let provider = Arc::new(FakeTranslationProvider {
            translation: Ok("Hello world".into()),
            inputs: translation_inputs.clone(),
        });
        let transcriber = Arc::new(FakeConversationTranscriber {
            transcription: Ok(ConversationTranscription {
                text: "Hola mundo".into(),
                locale: validate_locale(&locale("es", "ES")).unwrap(),
            }),
            inputs: transcription_inputs.clone(),
        });
        let service = SpeechServiceImpl::new(configured_client(endpoint))
            .with_test_conversation_providers(provider, transcriber, true);
        let config = validate_conversation_config(conversation_config(
            vec![locale("fr", "FR")],
            Some(SpeechConfig {
                audio_format: AudioFormat::Riff16khz16bitMonoPcm as i32,
                speech_source: SpeechSource::SourceGoogleSpeechSynthesis as i32,
                voice_name: "untrusted-voice".into(),
            }),
        ))
        .unwrap();

        let response = service
            .process_conversation(CompletedConversation {
                config,
                raw_pcm: vec![0x00, 0x01, 0x02, 0x03],
            })
            .await
            .unwrap();
        assert_eq!(response.transcript, "Hola mundo");
        assert_eq!(response.transcript_locale, Some(locale("es", "ES")));
        assert_eq!(response.translation, "Hello world");
        assert_eq!(response.translation_locale, Some(locale("en", "US")));
        assert_eq!(response.speech.unwrap().audio, riff);

        let transcription_inputs = transcription_inputs.lock().await;
        assert_eq!(transcription_inputs.len(), 1);
        assert_eq!(transcription_inputs[0].raw_pcm, [0x00, 0x01, 0x02, 0x03]);
        assert_eq!(
            transcription_inputs[0]
                .candidate_locales
                .iter()
                .map(ValidatedLocale::tag)
                .collect::<Vec<_>>(),
            ["en-US", "es-ES", "fr-FR"]
        );
        drop(transcription_inputs);

        let translation_inputs = translation_inputs.lock().await;
        assert_eq!(translation_inputs.len(), 1);
        assert_eq!(translation_inputs[0].text, "Hola mundo");
        assert_eq!(translation_inputs[0].source.tag(), "es-ES");
        assert_eq!(translation_inputs[0].target.tag(), "en-US");
        drop(translation_inputs);

        let captured_speech = captured_speech.lock().await;
        assert_eq!(captured_speech.len(), 1);
        let ssml = String::from_utf8_lossy(&captured_speech[0].body);
        assert!(ssml.contains("Hello world"));
        assert!(ssml.contains("en-US-AvaNeural"));
        assert!(!ssml.contains("untrusted-voice"));
        assert!(!ssml.contains("Hola mundo"));
    }

    #[tokio::test]
    async fn grpc_conversation_stream_half_close_returns_exactly_one_encrypted_response() {
        let (speech_endpoint, _) =
            spawn_mock_speech(HttpStatusCode::OK, vec![0x52, 0x49, 0x46, 0x46]).await;
        let provider = Arc::new(FakeTranslationProvider {
            translation: Ok("Hello".into()),
            inputs: Arc::new(Mutex::new(Vec::new())),
        });
        let transcriber = Arc::new(FakeConversationTranscriber {
            transcription: Ok(ConversationTranscription {
                text: "Hola".into(),
                locale: validate_locale(&locale("es", "ES")).unwrap(),
            }),
            inputs: Arc::new(Mutex::new(Vec::new())),
        });
        let service = SpeechServiceImpl::new(configured_client(speech_endpoint))
            .with_test_conversation_providers(provider, transcriber, true);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let incoming = async_stream::stream! {
            loop {
                match listener.accept().await {
                    Ok((socket, _)) => yield Ok::<_, std::io::Error>(socket),
                    Err(error) => {
                        yield Err(error);
                        break;
                    }
                }
            }
        };
        tokio::spawn(async move {
            Server::builder()
                .add_service(SpeechServiceServer::new(service))
                .serve_with_incoming(incoming)
                .await
                .unwrap();
        });

        let mut client = SpeechServiceClient::connect(format!("http://{address}"))
            .await
            .unwrap();
        let frames = tokio_stream::iter(vec![
            encrypted_conversation_frame(
                Some(conversation_config(
                    Vec::new(),
                    Some(SpeechConfig {
                        audio_format: AudioFormat::Riff16khz16bitMonoPcm as i32,
                        speech_source: SpeechSource::SourceUnspecified as i32,
                        voice_name: String::new(),
                    }),
                )),
                None,
                false,
                false,
            ),
            encrypted_conversation_frame(
                None,
                Some(Audio {
                    audio: vec![0x00, 0x01],
                    format: AudioFormat::Raw16khz16bitMonoPcm as i32,
                }),
                false,
                false,
            ),
        ]);
        let mut responses = client
            .translate_conversation(frames)
            .await
            .unwrap()
            .into_inner();
        let response = responses.message().await.unwrap().unwrap();
        assert!(responses.message().await.unwrap().is_none());
        let envelope = response.data.unwrap();
        assert_eq!(
            envelope.encryption_information.unwrap().kid,
            TRANSLATE_CONVERSATION_RESPONSE_KID
        );
        let response = TranslateConversationResponse::decode(envelope.data.as_slice()).unwrap();
        assert_eq!(response.transcript, "Hola");
        assert_eq!(response.transcript_locale, Some(locale("es", "ES")));
        assert_eq!(response.translation, "Hello");
        assert_eq!(response.translation_locale, Some(locale("en", "US")));
        assert_eq!(response.speech.unwrap().audio, [0x52, 0x49, 0x46, 0x46]);
    }

    #[tokio::test]
    async fn conversation_maps_detection_transcription_and_timeout_failures_without_tts() {
        for (failure, expected) in [
            (
                ConversationTranscriptionError::FailedToDetectLanguage,
                Code::FailedPrecondition,
            ),
            (
                ConversationTranscriptionError::FailedToTranscribe,
                Code::DataLoss,
            ),
            (
                ConversationTranscriptionError::Timeout,
                Code::DeadlineExceeded,
            ),
            (
                ConversationTranscriptionError::Unavailable,
                Code::Unavailable,
            ),
        ] {
            assert_eq!(status_for_transcription_error(failure).code(), expected);
        }
    }
}
