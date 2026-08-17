use std::sync::Arc;

use reqwest::Client as HttpClient;
use rig::providers;
use tracing::info;

use crate::config::ResolvedConfig;
use crate::llm::backend::LlmBackend;
use crate::llm::memory::MemoryService;
use crate::llm::request_log::LlmRequestLogger;
use crate::llm::rig_backend::RigBackend;

pub struct AnthropicProvider;

impl AnthropicProvider {
    pub async fn build(
        config: &ResolvedConfig,
        http_client: HttpClient,
        request_logger: LlmRequestLogger,
        memory: Option<MemoryService>,
    ) -> Result<Arc<dyn LlmBackend>, Box<dyn std::error::Error + Send + Sync>> {
        let llm_config = &config.config.llm;
        let api_key = llm_config.resolve_api_key().ok_or(
            "Anthropic api_key not set; configure ANTHROPIC_API_KEY in the environment or .env, or set llm.api_key in config.toml",
        )?;
        let client = providers::anthropic::Client::builder()
            .api_key(&api_key)
            .http_client(http_client.clone())
            .build()?;

        info!("Anthropic agent ready (model={})", llm_config.model);
        RigBackend::from_client(
            "Anthropic",
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
