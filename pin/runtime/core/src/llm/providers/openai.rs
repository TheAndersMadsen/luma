use std::sync::Arc;

use reqwest::Client as HttpClient;
use rig::providers;
use tracing::info;

use crate::config::ResolvedConfig;
use crate::llm::backend::LlmBackend;
use crate::llm::memory::MemoryService;
use crate::llm::request_log::LlmRequestLogger;
use crate::llm::rig_backend::RigBackend;

pub struct OpenAiProvider;

impl OpenAiProvider {
    pub async fn build(
        config: &ResolvedConfig,
        http_client: HttpClient,
        request_logger: LlmRequestLogger,
        memory: Option<MemoryService>,
    ) -> Result<Arc<dyn LlmBackend>, Box<dyn std::error::Error + Send + Sync>> {
        let llm_config = &config.config.llm;
        let api_key = llm_config.resolve_api_key().ok_or(
            "OpenAI api_key not set; configure OPENAI_API_KEY in the environment or .env, or set llm.api_key in config.toml",
        )?;
        let mut builder = providers::openai::CompletionsClient::builder()
            .api_key(&api_key)
            .http_client(http_client.clone());
        if let Some(ref base_url) = llm_config.base_url {
            builder = builder.base_url(base_url);
        }
        let client = builder.build()?;

        info!(
            "OpenAI agent ready (model={}, custom_base={})",
            llm_config.model,
            llm_config.base_url.is_some()
        );
        RigBackend::from_client(
            "OpenAI",
            client,
            request_logger,
            config,
            http_client,
            memory,
            |builder| builder,
        )
        .await
    }
}
