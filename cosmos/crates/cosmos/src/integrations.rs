//! Cosmos-owned provider configuration.
//!
//! Center edits this through the authenticated operator API. The Pin never
//! receives any provider credential; it receives only Cosmos connectivity and
//! device identity during provisioning.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};

use serde::{Deserialize, Serialize};

pub const DEFAULT_OPENAI_MODEL: &str = "openai/gpt-5.6-luna";
pub const DEFAULT_CODEX_MODEL: &str = "gpt-5.6-sol";
pub const DEFAULT_AZURE_VOICE: &str = "en-US-AvaMultilingualNeural";
const CONFIG_FILE: &str = "integrations.json";

#[derive(Debug, Clone, Copy, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssistantProvider {
    #[default]
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
    CodexSubscription,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct AssistantConfig {
    pub provider: AssistantProvider,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub fast_mode: bool,
    pub max_tokens: u32,
}

impl Default for AssistantConfig {
    fn default() -> Self {
        Self {
            provider: AssistantProvider::OpenAiCompatible,
            base_url: String::new(),
            api_key: None,
            model: DEFAULT_OPENAI_MODEL.to_owned(),
            reasoning_effort: None,
            fast_mode: false,
            max_tokens: 512,
        }
    }
}

impl AssistantConfig {
    pub fn configured(&self) -> bool {
        match self.provider {
            AssistantProvider::OpenAiCompatible => {
                !self.base_url.is_empty() && self.api_key.is_some() && !self.model.is_empty()
            }
            AssistantProvider::CodexSubscription => !self.model.is_empty(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SearchConfig {
    pub searxng_base_url: Option<String>,
    pub serpapi_key: Option<String>,
    pub perplexity_api_key: Option<String>,
    pub perplexity_model: Option<String>,
    pub wolfram_app_id: Option<String>,
    pub weather_api_key: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct MapsConfig {
    pub google_maps_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SpeechConfig {
    pub azure_key: Option<String>,
    pub azure_region: Option<String>,
    pub azure_voice: String,
}

impl Default for SpeechConfig {
    fn default() -> Self {
        Self {
            azure_key: None,
            azure_region: None,
            azure_voice: DEFAULT_AZURE_VOICE.to_owned(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct IntegrationsConfig {
    pub schema_version: u8,
    pub assistant: AssistantConfig,
    pub search: SearchConfig,
    pub maps: MapsConfig,
    pub speech: SpeechConfig,
}

impl Default for IntegrationsConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            assistant: AssistantConfig::default(),
            search: SearchConfig::default(),
            maps: MapsConfig::default(),
            speech: SpeechConfig::default(),
        }
    }
}

impl IntegrationsConfig {
    fn from_environment() -> Self {
        let mut config = Self::default();
        config.assistant.provider =
            match value_from_environment("COSMOS_ASSISTANT_PROVIDER").as_deref() {
                Some("codex-subscription") | Some("codex") => AssistantProvider::CodexSubscription,
                _ => AssistantProvider::OpenAiCompatible,
            };
        config.assistant.base_url =
            value_from_environment("COSMOS_LLM_BASE_URL").unwrap_or_default();
        config.assistant.api_key = value_from_environment("COSMOS_LLM_API_KEY")
            .or_else(|| value_from_environment("COSMOS_OPENROUTER_API_KEY"));
        config.assistant.model = value_from_environment("COSMOS_LLM_MODEL").unwrap_or_else(|| {
            match config.assistant.provider {
                AssistantProvider::OpenAiCompatible => DEFAULT_OPENAI_MODEL,
                AssistantProvider::CodexSubscription => DEFAULT_CODEX_MODEL,
            }
            .to_owned()
        });
        config.assistant.reasoning_effort = value_from_environment("COSMOS_LLM_REASONING_EFFORT");
        config.assistant.max_tokens = value_from_environment("COSMOS_LLM_MAX_TOKENS")
            .and_then(|value| value.parse().ok())
            .unwrap_or(512);

        config.search.searxng_base_url = value_from_environment("COSMOS_SEARXNG_BASE_URL");
        config.search.serpapi_key = value_from_environment("COSMOS_SERPAPI_KEY");
        config.search.perplexity_api_key = value_from_environment("COSMOS_PPLX_API_KEY");
        config.search.perplexity_model = value_from_environment("COSMOS_PPLX_MODEL");
        config.search.wolfram_app_id = value_from_environment("COSMOS_WOLFRAM_APP_ID");
        config.search.weather_api_key = value_from_environment("COSMOS_PIRATE_WEATHER_KEY");
        config.maps.google_maps_key = value_from_environment("COSMOS_GOOGLE_MAPS_KEY");
        config.speech.azure_key = value_from_environment("COSMOS_AZURE_SPEECH_KEY");
        config.speech.azure_region = value_from_environment("COSMOS_AZURE_SPEECH_REGION");
        config.speech.azure_voice = value_from_environment("COSMOS_AZURE_SPEECH_VOICE")
            .unwrap_or_else(|| DEFAULT_AZURE_VOICE.to_owned());
        normalize(&mut config);
        config
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct IntegrationsUpdate {
    pub assistant: Option<AssistantUpdate>,
    pub search: Option<SearchUpdate>,
    pub maps: Option<MapsUpdate>,
    pub speech: Option<SpeechUpdate>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AssistantUpdate {
    pub provider: Option<AssistantProvider>,
    pub base_url: Option<String>,
    /// Missing preserves the existing secret; an empty value removes it.
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: Option<bool>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SearchUpdate {
    pub searxng_base_url: Option<String>,
    pub serpapi_key: Option<String>,
    pub perplexity_api_key: Option<String>,
    pub perplexity_model: Option<String>,
    pub wolfram_app_id: Option<String>,
    pub weather_api_key: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MapsUpdate {
    pub google_maps_key: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SpeechUpdate {
    pub azure_key: Option<String>,
    pub azure_region: Option<String>,
    pub azure_voice: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum IntegrationError {
    #[error("integration configuration is invalid: {0}")]
    Invalid(&'static str),
    #[error("integration configuration cannot be persisted")]
    Persistence(#[from] io::Error),
}

pub struct IntegrationStore {
    config: RwLock<IntegrationsConfig>,
    path: Option<PathBuf>,
}

impl IntegrationStore {
    pub fn load(state_dir: Option<&str>) -> Result<Arc<Self>, IntegrationError> {
        let path = state_dir.map(|directory| Path::new(directory).join(CONFIG_FILE));
        let config = match path.as_ref().filter(|path| path.exists()) {
            Some(path) => serde_json::from_slice::<IntegrationsConfig>(&fs::read(path)?)
                .map_err(|_| IntegrationError::Invalid("stored JSON is malformed"))?,
            None => IntegrationsConfig::from_environment(),
        };
        validate(&config)?;
        Ok(Arc::new(Self {
            config: RwLock::new(config),
            path,
        }))
    }

    #[cfg(test)]
    pub fn memory(config: IntegrationsConfig) -> Arc<Self> {
        Arc::new(Self {
            config: RwLock::new(config),
            path: None,
        })
    }

    pub fn snapshot(&self) -> IntegrationsConfig {
        self.config
            .read()
            .expect("integration lock poisoned")
            .clone()
    }

    pub fn update(
        &self,
        update: IntegrationsUpdate,
    ) -> Result<IntegrationsConfig, IntegrationError> {
        let mut current = self.config.write().expect("integration lock poisoned");
        let mut next = current.clone();
        apply_update(&mut next, update);
        normalize(&mut next);
        validate(&next)?;
        self.persist(&next)?;
        *current = next.clone();
        Ok(next)
    }

    fn persist(&self, config: &IntegrationsConfig) -> Result<(), IntegrationError> {
        let path = self.path.as_ref().ok_or_else(|| {
            IntegrationError::Persistence(io::Error::new(
                io::ErrorKind::Unsupported,
                "COSMOS_STATE_DIR is not configured",
            ))
        })?;
        let parent = path.parent().expect("integration file has a parent");
        fs::create_dir_all(parent)?;
        let temporary = path.with_extension("json.new");
        let bytes = serde_json::to_vec_pretty(config)
            .map_err(|_| IntegrationError::Invalid("configuration cannot be encoded"))?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(temporary, path)?;
        Ok(())
    }

    pub fn value(&self, name: &str) -> Option<String> {
        let config = self.config.read().expect("integration lock poisoned");
        let value = match name {
            "COSMOS_ASSISTANT_PROVIDER" => Some(match config.assistant.provider {
                AssistantProvider::OpenAiCompatible => "openai-compatible".to_owned(),
                AssistantProvider::CodexSubscription => "codex-subscription".to_owned(),
            }),
            "COSMOS_LLM_BASE_URL" => (config.assistant.provider
                == AssistantProvider::OpenAiCompatible)
                .then(|| optional(&config.assistant.base_url))
                .flatten(),
            "COSMOS_LLM_API_KEY" | "COSMOS_OPENROUTER_API_KEY" => (config.assistant.provider
                == AssistantProvider::OpenAiCompatible)
                .then(|| config.assistant.api_key.clone())
                .flatten(),
            "COSMOS_LLM_MODEL" => optional(&config.assistant.model),
            "COSMOS_LLM_REASONING_EFFORT" => config.assistant.reasoning_effort.clone(),
            "COSMOS_LLM_MAX_TOKENS" => Some(config.assistant.max_tokens.to_string()),
            "COSMOS_SEARXNG_BASE_URL" => config.search.searxng_base_url.clone(),
            "COSMOS_SERPAPI_KEY" => config.search.serpapi_key.clone(),
            "COSMOS_PPLX_API_KEY" => config.search.perplexity_api_key.clone(),
            "COSMOS_PPLX_MODEL" => config.search.perplexity_model.clone(),
            "COSMOS_WOLFRAM_APP_ID" => config.search.wolfram_app_id.clone(),
            "COSMOS_PIRATE_WEATHER_KEY" => config.search.weather_api_key.clone(),
            "COSMOS_GOOGLE_MAPS_KEY" => config.maps.google_maps_key.clone(),
            "COSMOS_AZURE_SPEECH_KEY" => config.speech.azure_key.clone(),
            "COSMOS_AZURE_SPEECH_REGION" => config.speech.azure_region.clone(),
            "COSMOS_AZURE_SPEECH_VOICE" => optional(&config.speech.azure_voice),
            _ => return value_from_environment(name),
        };
        value.filter(|value| !value.trim().is_empty())
    }
}

static ACTIVE: OnceLock<Arc<IntegrationStore>> = OnceLock::new();

pub fn install(state_dir: Option<&str>) -> Result<Arc<IntegrationStore>, IntegrationError> {
    if let Some(active) = ACTIVE.get() {
        return Ok(active.clone());
    }
    let store = IntegrationStore::load(state_dir)?;
    let _ = ACTIVE.set(store.clone());
    Ok(ACTIVE.get().cloned().unwrap_or(store))
}

pub fn active() -> Arc<IntegrationStore> {
    ACTIVE
        .get_or_init(|| {
            IntegrationStore::load(std::env::var("COSMOS_STATE_DIR").ok().as_deref())
                .expect("integration configuration must be valid")
        })
        .clone()
}

pub fn value(name: &str) -> Option<String> {
    active().value(name)
}

/// Read speech readiness written by Center for another Cosmos workload. The
/// feature-flags service is a separate process, but shares the Cosmos state
/// volume with ai-bus. `None` means Center has not saved settings yet, so the
/// deployment's bootstrap environment may still be used during transition.
pub fn persisted_speech_ready(state_dir: Option<&str>) -> Result<Option<bool>, IntegrationError> {
    let Some(path) = state_dir.map(|directory| Path::new(directory).join(CONFIG_FILE)) else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let mut config = serde_json::from_slice::<IntegrationsConfig>(&fs::read(path)?)
        .map_err(|_| IntegrationError::Invalid("stored JSON is malformed"))?;
    normalize(&mut config);
    validate(&config)?;
    Ok(Some(
        config.speech.azure_key.is_some() && config.speech.azure_region.is_some(),
    ))
}

fn apply_update(config: &mut IntegrationsConfig, update: IntegrationsUpdate) {
    if let Some(update) = update.assistant {
        if let Some(value) = update.provider {
            config.assistant.provider = value;
            if value == AssistantProvider::CodexSubscription
                && config.assistant.model == DEFAULT_OPENAI_MODEL
            {
                config.assistant.model = DEFAULT_CODEX_MODEL.to_owned();
            }
        }
        if let Some(value) = update.base_url {
            config.assistant.base_url = value;
        }
        update_secret(&mut config.assistant.api_key, update.api_key);
        if let Some(value) = update.model {
            config.assistant.model = value;
        }
        if let Some(value) = update.reasoning_effort {
            config.assistant.reasoning_effort = optional(&value);
        }
        if let Some(value) = update.fast_mode {
            config.assistant.fast_mode = value;
        }
        if let Some(value) = update.max_tokens {
            config.assistant.max_tokens = value;
        }
    }
    if let Some(update) = update.search {
        update_secret(&mut config.search.searxng_base_url, update.searxng_base_url);
        update_secret(&mut config.search.serpapi_key, update.serpapi_key);
        update_secret(
            &mut config.search.perplexity_api_key,
            update.perplexity_api_key,
        );
        update_secret(&mut config.search.perplexity_model, update.perplexity_model);
        update_secret(&mut config.search.wolfram_app_id, update.wolfram_app_id);
        update_secret(&mut config.search.weather_api_key, update.weather_api_key);
    }
    if let Some(update) = update.maps {
        update_secret(&mut config.maps.google_maps_key, update.google_maps_key);
    }
    if let Some(update) = update.speech {
        update_secret(&mut config.speech.azure_key, update.azure_key);
        update_secret(&mut config.speech.azure_region, update.azure_region);
        if let Some(value) = update.azure_voice {
            config.speech.azure_voice = value;
        }
    }
}

fn update_secret(target: &mut Option<String>, update: Option<String>) {
    if let Some(value) = update {
        *target = optional(&value);
    }
}

fn normalize(config: &mut IntegrationsConfig) {
    config.assistant.base_url = config
        .assistant
        .base_url
        .trim()
        .trim_end_matches('/')
        .to_owned();
    config.assistant.model = config.assistant.model.trim().to_owned();
    config.assistant.reasoning_effort = config
        .assistant
        .reasoning_effort
        .take()
        .and_then(|value| optional(&value.to_ascii_lowercase()));
    config.speech.azure_voice = config.speech.azure_voice.trim().to_owned();
    for value in [
        &mut config.assistant.api_key,
        &mut config.search.searxng_base_url,
        &mut config.search.serpapi_key,
        &mut config.search.perplexity_api_key,
        &mut config.search.perplexity_model,
        &mut config.search.wolfram_app_id,
        &mut config.search.weather_api_key,
        &mut config.maps.google_maps_key,
        &mut config.speech.azure_key,
        &mut config.speech.azure_region,
    ] {
        *value = value.take().and_then(|value| optional(&value));
    }
    if let Some(url) = config.search.searxng_base_url.as_mut() {
        *url = url.trim_end_matches('/').to_owned();
    }
}

fn validate(config: &IntegrationsConfig) -> Result<(), IntegrationError> {
    if config.schema_version != 1 {
        return Err(IntegrationError::Invalid("unsupported schema version"));
    }
    if config.assistant.model.is_empty() || config.assistant.model.len() > 256 {
        return Err(IntegrationError::Invalid("assistant model is required"));
    }
    if config.assistant.max_tokens > 65_536 {
        return Err(IntegrationError::Invalid(
            "assistant token limit is too large",
        ));
    }
    if let Some(effort) = config.assistant.reasoning_effort.as_deref() {
        let supported = match config.assistant.provider {
            AssistantProvider::OpenAiCompatible => {
                matches!(effort, "minimal" | "low" | "medium" | "high" | "xhigh")
            }
            AssistantProvider::CodexSubscription => {
                matches!(
                    effort,
                    "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
                )
            }
        };
        if !supported {
            return Err(IntegrationError::Invalid(
                "reasoning effort is not supported by the selected assistant provider",
            ));
        }
    }
    if !config.assistant.base_url.is_empty() {
        validate_url(&config.assistant.base_url, "assistant URL is invalid")?;
    }
    if let Some(url) = config.search.searxng_base_url.as_deref() {
        validate_url(url, "SearxNG URL is invalid")?;
    }
    for secret in [
        config.assistant.api_key.as_deref(),
        config.search.serpapi_key.as_deref(),
        config.search.perplexity_api_key.as_deref(),
        config.search.wolfram_app_id.as_deref(),
        config.search.weather_api_key.as_deref(),
        config.maps.google_maps_key.as_deref(),
        config.speech.azure_key.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if secret.len() > 8192 || secret.contains(['\r', '\n', '\0']) {
            return Err(IntegrationError::Invalid("credential is invalid"));
        }
    }
    if let Some(region) = config.speech.azure_region.as_deref()
        && (region.len() > 64
            || !region
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'))
    {
        return Err(IntegrationError::Invalid("Azure Speech region is invalid"));
    }
    if config.speech.azure_voice.is_empty()
        || config.speech.azure_voice.len() > 128
        || !config
            .speech
            .azure_voice
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(IntegrationError::Invalid("Azure Speech voice is invalid"));
    }
    Ok(())
}

fn validate_url(value: &str, message: &'static str) -> Result<(), IntegrationError> {
    let url = reqwest::Url::parse(value).map_err(|_| IntegrationError::Invalid(message))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(IntegrationError::Invalid(message));
    }
    Ok(())
}

fn optional(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn value_from_environment(name: &str) -> Option<String> {
    std::env::var(name).ok().and_then(|value| optional(&value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn update_preserves_omitted_secrets_and_clears_explicit_empty_secrets() {
        let mut config = IntegrationsConfig::default();
        config.assistant.api_key = Some("existing".to_owned());
        let store = IntegrationStore::memory(config);

        let mut next = store.snapshot();
        apply_update(
            &mut next,
            IntegrationsUpdate {
                assistant: Some(AssistantUpdate {
                    model: Some("new-model".to_owned()),
                    ..AssistantUpdate::default()
                }),
                ..IntegrationsUpdate::default()
            },
        );
        assert_eq!(next.assistant.api_key.as_deref(), Some("existing"));

        apply_update(
            &mut next,
            IntegrationsUpdate {
                assistant: Some(AssistantUpdate {
                    api_key: Some(String::new()),
                    ..AssistantUpdate::default()
                }),
                ..IntegrationsUpdate::default()
            },
        );
        assert_eq!(next.assistant.api_key, None);
    }

    #[test]
    fn validation_rejects_credentials_in_urls_and_unknown_effort() {
        let mut config = IntegrationsConfig::default();
        config.assistant.base_url = "https://user:secret@example.test/v1".to_owned();
        assert!(validate(&config).is_err());
        config.assistant.base_url = "https://example.test/v1".to_owned();
        config.assistant.reasoning_effort = Some("maximum".to_owned());
        assert!(validate(&config).is_err());
    }

    #[test]
    fn codex_reasoning_effort_rejects_minimal_and_accepts_its_supported_levels() {
        let mut config = IntegrationsConfig::default();
        config.assistant.provider = AssistantProvider::CodexSubscription;

        config.assistant.reasoning_effort = Some("minimal".to_owned());
        assert!(validate(&config).is_err());

        for effort in ["low", "medium", "high", "xhigh", "max", "ultra"] {
            config.assistant.reasoning_effort = Some(effort.to_owned());
            assert!(validate(&config).is_ok(), "Codex should accept {effort}");
        }

        config.assistant.provider = AssistantProvider::OpenAiCompatible;
        config.assistant.reasoning_effort = Some("minimal".to_owned());
        assert!(validate(&config).is_ok());
    }

    #[test]
    fn persisted_dashboard_settings_reload_from_an_owner_only_file() {
        let directory =
            std::env::temp_dir().join(format!("cosmos-integrations-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        assert_eq!(persisted_speech_ready(directory.to_str()).unwrap(), None);
        let store = IntegrationStore::load(directory.to_str()).unwrap();
        store
            .update(IntegrationsUpdate {
                assistant: Some(AssistantUpdate {
                    base_url: Some("https://openrouter.ai/api/v1/".to_owned()),
                    api_key: Some("private-provider-key".to_owned()),
                    model: Some("openai/gpt-5.6-luna".to_owned()),
                    fast_mode: Some(true),
                    ..AssistantUpdate::default()
                }),
                speech: Some(SpeechUpdate {
                    azure_key: Some("private-speech-key".to_owned()),
                    azure_region: Some("westeurope".to_owned()),
                    ..SpeechUpdate::default()
                }),
                ..IntegrationsUpdate::default()
            })
            .unwrap();

        let path = directory.join(CONFIG_FILE);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let reloaded = IntegrationStore::load(directory.to_str())
            .unwrap()
            .snapshot();
        assert_eq!(reloaded.assistant.base_url, "https://openrouter.ai/api/v1");
        assert_eq!(
            reloaded.assistant.api_key.as_deref(),
            Some("private-provider-key")
        );
        assert!(reloaded.assistant.fast_mode);
        assert_eq!(reloaded.speech.azure_region.as_deref(), Some("westeurope"));
        assert_eq!(
            persisted_speech_ready(directory.to_str()).unwrap(),
            Some(true)
        );

        store
            .update(IntegrationsUpdate {
                speech: Some(SpeechUpdate {
                    azure_key: Some(String::new()),
                    ..SpeechUpdate::default()
                }),
                ..IntegrationsUpdate::default()
            })
            .unwrap();
        assert_eq!(
            persisted_speech_ready(directory.to_str()).unwrap(),
            Some(false)
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn selecting_codex_disables_the_stored_openai_endpoint() {
        let mut config = IntegrationsConfig::default();
        config.assistant.provider = AssistantProvider::CodexSubscription;
        config.assistant.base_url = "https://openrouter.ai/api/v1".to_owned();
        config.assistant.api_key = Some("kept-for-later".to_owned());
        let store = IntegrationStore::memory(config);

        assert_eq!(store.value("COSMOS_LLM_BASE_URL"), None);
        assert_eq!(store.value("COSMOS_LLM_API_KEY"), None);
    }
}
