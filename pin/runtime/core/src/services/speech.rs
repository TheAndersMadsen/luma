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
    validate_locale, TextTranslationProvider, TranslationInput, ValidatedLocale,
    MAX_TRANSLATION_TEXT_BYTES,
};
use crate::config::ResolvedConfig;
use crate::external::azure_speech::{
    AzureSpeechClient, AzureSpeechError, AzureSpeechOutputFormat, SynthesizedSpeech,
};
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
// 64 KiB. Retain 16 KiB for the protobuf, class name, Parcel, and Binder frame.
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
    pub fn new(azure_speech: AzureSpeechClient) -> Self {
        Self {
            azure_speech: Arc::new(RwLock::new(azure_speech)),
            translation: Arc::new(RwLock::new(TranslationRuntime::default())),
        }
    }

    /// Construct the device-local speech service. Cosmos owns translation, so
    /// the Pin deliberately has no translation provider.
    pub fn new_with_config(azure_speech: AzureSpeechClient, config: Arc<ResolvedConfig>) -> Self {
        let runtime = TranslationRuntime {
            provider: None,
            transcriber: AzureConversationTranscriber::configured(&config),
            tts_ready: azure_tts_is_configured(&config),
        };
        Self {
            azure_speech: Arc::new(RwLock::new(azure_speech)),
            translation: Arc::new(RwLock::new(runtime)),
        }
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
        // fields describe device context. They are not an authorization denial
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

    use axum::body::Body;
    use axum::extract::{Request as AxumRequest, State};
    use axum::http::StatusCode as HttpStatusCode;
    use axum::response::Response as AxumResponse;
    use axum::routing::any;
    use axum::Router;
    use reqwest::Url;
    use tokio::net::TcpListener;
    use tokio::sync::Mutex;

    use tonic::Code;

    use crate::external::azure_speech::AzureSpeechOptions;

    use crate::proto::aibus::speech_service_server::SpeechServiceServer;
    use crate::proto::aibus::{
        EncryptedTranslateConversationRequest, Locale, SpeechConfig, SynapseSpeechContent,
        TranslateConversationConfig, TranslateConversationRequest, TranslateConversationResponse,
    };
    use crate::proto::common::encryption::EncryptedData;

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

    struct CapturedRequest;

    async fn mock_speech_handler(
        State(state): State<MockState>,
        request: AxumRequest,
    ) -> AxumResponse {
        let _ = request;
        state.captured.lock().await.push(CapturedRequest);
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
}
