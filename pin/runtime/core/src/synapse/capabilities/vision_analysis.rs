use std::sync::Arc;
use std::time::Duration;

use crate::config::{LlmProvider, ResolvedConfig};
use crate::llm::{ChatResult, LlmAgent, LlmChatRequest, PromptTemplateContext, PromptTemplates};

const IMAGE_ANALYSIS_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_ANALYSIS_PROMPT_BYTES: usize = 8 * 1024;

/// Run one image-only model request behind a short timeout and a purpose-built
/// system prompt. Callers still own strict response decoding and all effects.
/// In particular, this helper never dispatches tools or device actions.
pub async fn image_model_text(
    agent: &Arc<LlmAgent>,
    config: &Arc<ResolvedConfig>,
    run_id: &str,
    system_prompt: &str,
    prompt: String,
    image: Vec<u8>,
) -> Result<String, ImageAnalysisError> {
    let request = build_image_analysis_request(config, run_id, system_prompt, prompt, image)?;

    match tokio::time::timeout(IMAGE_ANALYSIS_TIMEOUT, agent.chat(request)).await {
        Ok(Ok(ChatResult::Text(text))) if !text.trim().is_empty() => Ok(text),
        Ok(Ok(ChatResult::Text(_))) => Err(ImageAnalysisError::EmptyResponse),
        Ok(Ok(ChatResult::DeferredVision)) => Err(ImageAnalysisError::NestedVisionRequest),
        Ok(Err(_)) => Err(ImageAnalysisError::Provider),
        Err(_) => Err(ImageAnalysisError::Timeout),
    }
}

/// Build the one bounded, tool-free image-analysis request. This is the single
/// camera->cloud chokepoint for every `image_model_text` caller: it fails
/// closed without the independent vision cloud-consent acknowledgement, and it
/// routes the image to the configured vision-capable model (when one is set)
/// instead of the main text model.
fn build_image_analysis_request(
    config: &Arc<ResolvedConfig>,
    run_id: &str,
    system_prompt: &str,
    prompt: String,
    image: Vec<u8>,
) -> Result<LlmChatRequest, ImageAnalysisError> {
    if prompt.is_empty() || prompt.len() > MAX_ANALYSIS_PROMPT_BYTES || image.is_empty() {
        return Err(ImageAnalysisError::InvalidInput);
    }
    // Camera images may leave the device only under the explicit, fail-closed
    // consent acknowledgement. This mirrors the Azure Speech cloud-consent
    // gate and is enforced before any provider client is touched.
    if !config.config.llm.vision_consent_acknowledged {
        return Err(ImageAnalysisError::ConsentRequired);
    }
    if !read_only_image_request_allowed(config.config.llm.provider, config.config.llm.tools.enabled)
    {
        return Err(ImageAnalysisError::ToolEnabledProvider);
    }

    let mut request = LlmChatRequest::new(
        prompt,
        Vec::new(),
        PromptTemplates {
            system_prompt: system_prompt.to_string(),
            status_prompt: String::new(),
        },
        PromptTemplateContext::new(run_id, config, chrono::Local::now()),
        None,
    )
    .with_tool_free_text_output()
    .with_image(image);
    if let Some(vision_model) = config.config.llm.resolve_vision_model() {
        request = request.with_model_override(vision_model);
    }
    Ok(request)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageAnalysisError {
    InvalidInput,
    /// The operator has not acknowledged the camera->cloud consent gate
    /// (`llm.vision_consent_acknowledged`), so the image was not sent.
    ConsentRequired,
    ToolEnabledProvider,
    EmptyResponse,
    NestedVisionRequest,
    Provider,
    Timeout,
}

impl ImageAnalysisError {
    pub fn kind(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::ConsentRequired => "consent_required",
            Self::ToolEnabledProvider => "tool_enabled_provider",
            Self::EmptyResponse => "empty_response",
            Self::NestedVisionRequest => "nested_vision_request",
            Self::Provider => "provider",
            Self::Timeout => "timeout",
        }
    }
}

/// All providers use the tool-free structured agent for image analysis,
/// preventing any side effects through the tool loop. The gate is retained
/// for defense-in-depth but now allows all providers.
fn read_only_image_request_allowed(_provider: LlmProvider, _tools_enabled: bool) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::request::LlmResponseMode;

    /// A synthetic camera fixture: JPEG magic bytes only, no real content.
    const FIXTURE_JPEG: [u8; 4] = [0xff, 0xd8, 0xff, 0xdb];

    fn resolved_config(vision_model: Option<&str>, consent: bool) -> Arc<ResolvedConfig> {
        let mut config: crate::config::Config = toml::from_str("").unwrap();
        config.llm.vision_model = vision_model.map(str::to_string);
        config.llm.vision_consent_acknowledged = consent;
        Arc::new(ResolvedConfig::resolve(config))
    }

    #[test]
    fn unacknowledged_vision_consent_blocks_the_image_before_any_provider_request_exists() {
        // Camera->cloud is fail-closed: with the default (unacknowledged)
        // consent no LlmChatRequest is ever built, for any caller of
        // image_model_text (AnalyzeImage, visual music, visual nutrition).
        let config = resolved_config(Some("qwen-vl-max"), false);
        let Err(error) = build_image_analysis_request(
            &config,
            "run-1",
            "system",
            "describe".to_string(),
            FIXTURE_JPEG.to_vec(),
        ) else {
            panic!("expected the consent gate to block the request");
        };
        assert_eq!(error, ImageAnalysisError::ConsentRequired);
        assert_eq!(error.kind(), "consent_required");

        // Consent alone is also insufficient for malformed inputs.
        let consented = resolved_config(Some("qwen-vl-max"), true);
        let Err(error) = build_image_analysis_request(
            &consented,
            "run-1",
            "system",
            String::new(),
            FIXTURE_JPEG.to_vec(),
        ) else {
            panic!("expected invalid input to be rejected");
        };
        assert_eq!(error, ImageAnalysisError::InvalidInput);
    }

    #[test]
    fn consented_image_request_carries_an_image_part_and_the_configured_vision_model() {
        let config = resolved_config(Some("qwen-vl-max"), true);
        let request = build_image_analysis_request(
            &config,
            "run-1",
            "system",
            "describe".to_string(),
            FIXTURE_JPEG.to_vec(),
        )
        .unwrap();

        // The image travels as a real request asset (the backend renders it as
        // a multimodal image part), bound for the vision-capable model rather
        // than the main text model, in the tool-free response mode.
        assert_eq!(request.image.as_deref(), Some(&FIXTURE_JPEG[..]));
        assert_eq!(request.model_override.as_deref(), Some("qwen-vl-max"));
        assert_eq!(request.response_mode, LlmResponseMode::ToolFreeText);

        // Without a configured vision model the request keeps the main model
        // (no override), preserving the pre-existing behavior.
        let unconfigured = resolved_config(None, true);
        let request = build_image_analysis_request(
            &unconfigured,
            "run-1",
            "system",
            "describe".to_string(),
            FIXTURE_JPEG.to_vec(),
        )
        .unwrap();
        assert_eq!(request.model_override, None);
        assert!(request.image.is_some());
    }

    #[test]
    fn image_analysis_forces_tool_free_output_so_no_provider_enters_a_tool_loop() {
        // The provider gate is now defense-in-depth and intentionally allows
        // every provider: image analysis is kept safe by forcing tool-free
        // output rather than by rejecting tool-enabled providers.
        for provider in [
            LlmProvider::Codex,
            LlmProvider::Gemini,
            LlmProvider::OpenAi,
            LlmProvider::Anthropic,
            LlmProvider::OpenAiCompatible,
        ] {
            assert!(read_only_image_request_allowed(provider, true));
            assert!(read_only_image_request_allowed(provider, false));
        }

        // The real guard: `image_model_text` builds its request with a tool-free
        // response mode distinct from the default voice mode. The rig and codex
        // backends route only the voice mode into the tool loop and every other
        // mode to a single tool-free completion, so image analysis can never
        // enter a side-effect-capable tool loop.
        let build_request = |tool_free: bool| {
            let context = PromptTemplateContext {
                run_id: "run".to_string(),
                assistant_display_name: None,
                server_public_addr: "127.0.0.1:0".to_string(),
                current_timestamp: String::new(),
                current_date: String::new(),
                current_time: String::new(),
                location_name: None,
                latitude: None,
                longitude: None,
                coordinates: None,
            };
            let request = LlmChatRequest::new(
                "describe".to_string(),
                Vec::new(),
                PromptTemplates {
                    system_prompt: "system".to_string(),
                    status_prompt: String::new(),
                },
                context,
                None,
            );
            if tool_free {
                request
                    .with_tool_free_text_output()
                    .with_image(vec![1, 2, 3])
            } else {
                request
            }
        };
        let tool_free = build_request(true);
        let default_voice = build_request(false);
        assert_ne!(tool_free.response_mode, default_voice.response_mode);
        assert!(tool_free.image.is_some());
    }
}
