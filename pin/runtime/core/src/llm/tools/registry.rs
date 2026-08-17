use std::sync::Arc;

use rig::agent::{AgentBuilder, PromptHook};
use rig::completion::CompletionModel;
use rig::embeddings::EmbeddingsBuilder;
use rig::tool::ToolSet;
use rig::vector_store::in_memory_store::{InMemoryVectorIndex, InMemoryVectorStore};
use tracing::{info, warn};

use crate::config::{LlmConfig, ResolvedConfig, TemperatureUnit};
use crate::external::osm::OsmClient;
use crate::external::weather::WeatherClient;
use crate::llm::memory::MemoryService;
use crate::llm::tools::memory::{
    ForgetMemoryTool, RememberTool, SearchMemoryTool, UpdateMemoryTool,
};
use crate::nearby::NearbyClient;

use super::fastembed;
#[cfg(target_os = "android")]
use super::logcat::DumpLogcatTool;
use super::nearby_search::NearbySearchTool;
use super::reverse_geocode::ReverseGeocodeTool;
use super::understand_scene::UnderstandSceneTool;
use super::weather::WeatherTool;

#[derive(Clone)]
pub struct LlmToolContext {
    pub nearby_client: Arc<NearbyClient>,
    pub osm: OsmClient,
    pub weather: WeatherClient,
    pub temperature_unit: TemperatureUnit,
    pub memory: Option<MemoryService>,
}

impl LlmToolContext {
    pub fn new(
        http_client: reqwest::Client,
        config: &ResolvedConfig,
        memory: Option<MemoryService>,
    ) -> Self {
        Self {
            nearby_client: Arc::new(NearbyClient::new(
                http_client.clone(),
                config.openstreetmap_options.clone(),
            )),
            osm: OsmClient::new(http_client.clone(), config.openstreetmap_options.clone()),
            weather: WeatherClient::new(http_client, config.pirate_weather_api_key.clone()),
            temperature_unit: config.config.weather.temperature_unit,
            memory,
        }
    }

    pub async fn build_tool_resources(
        &self,
        config: &LlmConfig,
    ) -> Result<Option<ToolResources>, String> {
        let tools_config = &config.tools;
        if !tools_config.enabled {
            info!("LLM native tools disabled by config");
            return Ok(None);
        }

        if tools_config.dynamic_tool_count == 0 {
            warn!(
                "LLM native tools enabled but dynamic_tool_count is 0; no tools will be attached"
            );

            return Ok(None);
        }

        let toolset = self.build_toolset();

        let schemas = toolset.schemas().map_err(|err| err.to_string())?;
        if schemas.is_empty() {
            warn!("LLM native tools enabled but registry produced no dynamic tool schemas");
            return Ok(None);
        }

        let embedding_model = fastembed::build_embedding_model()?;
        let embeddings = EmbeddingsBuilder::new(embedding_model.clone())
            .documents(schemas)
            .map_err(|err| err.to_string())?
            .build()
            .await
            .map_err(|err| err.to_string())?;

        let vector_store: InMemoryVectorStore<rig::embeddings::ToolSchema> =
            InMemoryVectorStore::from_documents_with_id_f(embeddings, |tool| tool.name.clone());
        let index = vector_store.index(embedding_model);

        info!(
            dynamic_tool_count = tools_config.dynamic_tool_count,
            "LLM native dynamic tools ready"
        );

        Ok(Some(ToolResources {
            sample_count: tools_config.dynamic_tool_count,
            index,
            toolset,
        }))
    }

    fn build_toolset(&self) -> ToolSet {
        let builder = ToolSet::builder().dynamic_tool(UnderstandSceneTool);

        let osm_options = self.osm.options();
        let builder = if osm_options.enabled() && osm_options.location_consent_acknowledged() {
            builder
                .dynamic_tool(NearbySearchTool::new(self.nearby_client.clone()))
                .dynamic_tool(ReverseGeocodeTool::new(self.osm.clone()))
        } else {
            builder
        };

        #[cfg(target_os = "android")]
        let builder = builder.dynamic_tool(DumpLogcatTool);

        let builder = if self.weather.is_configured() {
            builder.dynamic_tool(WeatherTool::new(
                self.weather.clone(),
                self.temperature_unit,
            ))
        } else {
            builder
        };

        let builder = if let Some(memory) = &self.memory {
            builder
                .dynamic_tool(RememberTool::new(memory.clone()))
                .dynamic_tool(SearchMemoryTool::new(memory.clone()))
                .dynamic_tool(UpdateMemoryTool::new(memory.clone()))
                .dynamic_tool(ForgetMemoryTool::new(memory.clone()))
        } else {
            builder
        };

        builder.build()
    }
}

pub struct ToolResources {
    pub sample_count: usize,
    pub index: InMemoryVectorIndex<rig_fastembed::EmbeddingModel, rig::embeddings::ToolSchema>,
    pub toolset: ToolSet,
}

impl ToolResources {
    pub fn apply<M, P>(
        self,
        builder: AgentBuilder<M, P>,
    ) -> AgentBuilder<M, P, rig::agent::WithBuilderTools>
    where
        M: CompletionModel,
        P: PromptHook<M>,
    {
        builder.dynamic_tools(self.sample_count, self.index, self.toolset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external::osm::OsmOptions;

    fn tool_context(options: OsmOptions) -> LlmToolContext {
        let http = reqwest::Client::new();
        LlmToolContext {
            nearby_client: Arc::new(NearbyClient::new(http.clone(), options.clone())),
            osm: OsmClient::new(http.clone(), options),
            weather: WeatherClient::new(http, None),
            temperature_unit: TemperatureUnit::Celsius,
            memory: None,
        }
    }

    fn schema_names(context: &LlmToolContext) -> Vec<String> {
        context
            .build_toolset()
            .schemas()
            .expect("tool schemas")
            .into_iter()
            .map(|schema| schema.name)
            .collect()
    }

    #[test]
    fn osm_tools_are_not_advertised_without_both_privacy_gates() {
        for options in [OsmOptions::default(), OsmOptions::new(true, false)] {
            let names = schema_names(&tool_context(options));
            assert!(!names.iter().any(|name| name == "nearby_search"));
            assert!(!names.iter().any(|name| name == "reverse_geocode"));
            assert!(names.iter().any(|name| name == "understand_scene"));
        }
    }

    #[test]
    fn osm_tools_are_advertised_after_enablement_and_consent() {
        let names = schema_names(&tool_context(OsmOptions::new(true, true)));
        assert!(names.iter().any(|name| name == "nearby_search"));
        assert!(names.iter().any(|name| name == "reverse_geocode"));
    }
}
