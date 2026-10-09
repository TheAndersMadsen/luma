//! Cosmos-owned provider configuration.
//!
//! Center edits this through the authenticated operator API. The Pin never
//! receives any provider credential. It receives only Cosmos connectivity and
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
/// What Cosmos last saw of the OS3 connection. An observation, not a setting,
/// so it sits beside the settings rather than in them.
const OS3_STATUS_FILE: &str = "os3-status.json";
/// A whole browser `Cookie` header can exceed one cookie's 4 KiB limit.
const MAX_OS3_COOKIE_BYTES: usize = 16 * 1024;
/// OS3's display name for the owner's agent, as Center shows it.
pub const MAX_OS3_BUTLER_NAME_CHARS: usize = 64;
/// Saved assistant profiles the owner switches between.
pub const MAX_ASSISTANT_PROFILES: usize = 16;
pub const MAX_ASSISTANT_PROFILE_NAME_CHARS: usize = 64;

#[derive(Debug, Clone, Copy, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssistantProvider {
    #[default]
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
    CodexSubscription,
}

/// The assistant settings in use, plus the profiles the owner saved under
/// a name so switching between them needs no retyping. The flat fields are
/// what the assistant reads; a saved profile is a copy of them.
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
    /// Written only once the owner saves a profile, so a release without
    /// this field still reads the file until then.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub profiles: Vec<AssistantProfile>,
}

/// One saved assistant profile: the settings under a name of the owner's
/// choosing. A Codex profile carries no URL or key; its sign-in is the
/// Codex app server's own and shared by every Codex profile.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct AssistantProfile {
    pub name: String,
    pub provider: AssistantProvider,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub fast_mode: bool,
    pub max_tokens: u32,
}

impl Default for AssistantProfile {
    fn default() -> Self {
        AssistantConfig::default().as_profile(String::new())
    }
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
            profiles: Vec::new(),
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

    /// The settings in use as a profile named `name`. A Codex profile
    /// keeps no URL or key: they belong to OpenAI-compatible profiles.
    pub fn as_profile(&self, name: String) -> AssistantProfile {
        let codex = self.provider == AssistantProvider::CodexSubscription;
        AssistantProfile {
            name,
            provider: self.provider,
            base_url: if codex {
                String::new()
            } else {
                self.base_url.clone()
            },
            api_key: if codex { None } else { self.api_key.clone() },
            model: self.model.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
            fast_mode: self.fast_mode,
            max_tokens: self.max_tokens,
        }
    }

    /// Make `profile`'s settings the ones in use.
    fn load_profile(&mut self, profile: &AssistantProfile) {
        self.provider = profile.provider;
        self.base_url = profile.base_url.clone();
        self.api_key = profile.api_key.clone();
        self.model = profile.model.clone();
        self.reasoning_effort = profile.reasoning_effort.clone();
        self.fast_mode = profile.fast_mode;
        self.max_tokens = profile.max_tokens;
    }

    /// The saved profile whose settings are the ones in use, if any.
    /// Derived, never stored, so it cannot drift from the settings.
    pub fn active_profile(&self) -> Option<&str> {
        let active = self.as_profile(String::new());
        self.profiles
            .iter()
            .find(|profile| {
                profile.provider == active.provider
                    && profile.base_url == active.base_url
                    && profile.api_key == active.api_key
                    && profile.model == active.model
                    && profile.reasoning_effort == active.reasoning_effort
                    && profile.fast_mode == active.fast_mode
                    && profile.max_tokens == active.max_tokens
            })
            .map(|profile| profile.name.as_str())
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SearchConfig {
    pub searxng_base_url: Option<String>,
    pub searxng_language: Option<String>,
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

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct FoodConfig {
    pub open_food_facts_username: Option<String>,
    pub open_food_facts_password: Option<String>,
}

impl FoodConfig {
    pub fn configured(&self) -> bool {
        self.open_food_facts_username.is_some() && self.open_food_facts_password.is_some()
    }
}

/// Optional connection to OS3, Rabbit's agent service. Off by default and
/// configured only from Center: the credential is a browser session cookie that
/// expires, so no environment value seeds it.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Os3Config {
    pub enabled: bool,
    /// The `Cookie` request header value of a signed-in os3.rabbit.tech session.
    pub session_cookie: Option<String>,
}

impl Os3Config {
    pub fn configured(&self) -> bool {
        self.enabled && self.session_cookie.is_some()
    }
}

impl std::fmt::Debug for Os3Config {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Os3Config")
            .field("enabled", &self.enabled)
            .field("session_cookie_configured", &self.session_cookie.is_some())
            .finish()
    }
}

/// What the last contact with OS3 showed, naming the step that failed.
/// Only a contact that went through is `Connected`.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Os3State {
    /// Nothing has reached OS3 with the current cookie yet.
    #[default]
    Untested,
    /// OS3 accepted the cookie, and the test or question went through.
    Connected,
    /// OS3 refused the cookie. The owner pastes a fresh one.
    SignInExpired,
    /// Rabbit's edge turned the request away before any sign-in check.
    Blocked,
    /// OS3 accepted the sign-in but named no instance for the account.
    NoInstance,
    /// The conversation socket was refused, or closed before it opened.
    SocketRefused,
    /// OS3 could not be reached.
    Unavailable,
    /// The connection dropped during a question.
    Dropped,
    /// OS3 did not respond in time.
    TimedOut,
}

/// Center's view of the OS3 connection: what the last test or question saw,
/// and when the assistant last asked OS3. Holds no credential and no account
/// detail beyond OS3's display name for the agent. The conversation a
/// question resumes is tied to the cookie it was made with, so a new cookie,
/// possibly for another OS3 account, never resumes it (`backends::os3`).
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Os3Status {
    /// INFERRED: binds this derived observation to its stored credential.
    /// Persisted only in the existing status file. Excluded from Center's DTO.
    pub(crate) cookie_digest: Option<String>,
    pub state: Os3State,
    /// `init_ack.butlerName` from the last connection, while connected.
    pub butler_name: Option<String>,
    /// Unix milliseconds of the last contact with OS3.
    pub checked_at_ms: Option<u64>,
    /// Unix milliseconds of the last question the assistant asked OS3.
    pub last_used_at_ms: Option<u64>,
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
    pub food: FoodConfig,
    pub os3: Os3Config,
}

impl Default for IntegrationsConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            assistant: AssistantConfig::default(),
            search: SearchConfig::default(),
            maps: MapsConfig::default(),
            speech: SpeechConfig::default(),
            food: FoodConfig::default(),
            os3: Os3Config::default(),
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
        config.assistant.api_key = value_from_environment("COSMOS_LLM_API_KEY");
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
        config.search.searxng_language = value_from_environment("COSMOS_SEARXNG_LANGUAGE");
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
        config.food.open_food_facts_username =
            value_from_environment("COSMOS_OPEN_FOOD_FACTS_USERNAME");
        config.food.open_food_facts_password =
            value_from_environment("COSMOS_OPEN_FOOD_FACTS_PASSWORD");
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
    pub food: Option<FoodUpdate>,
    pub os3: Option<Os3Update>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AssistantUpdate {
    /// Start from this saved profile: its settings, key included, become
    /// the ones in use before the fields below apply.
    pub load_profile: Option<String>,
    pub provider: Option<AssistantProvider>,
    pub base_url: Option<String>,
    /// Missing preserves the existing secret. An empty value removes it.
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: Option<bool>,
    pub max_tokens: Option<u32>,
    /// Save the resulting settings as this profile, added or replaced.
    pub save_profile: Option<String>,
    /// Delete this saved profile. The settings in use are unchanged.
    pub delete_profile: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SearchUpdate {
    pub searxng_base_url: Option<String>,
    pub searxng_language: Option<String>,
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

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FoodUpdate {
    /// Missing preserves the existing credential. An empty value removes it.
    pub open_food_facts_username: Option<String>,
    /// Missing preserves the existing credential. An empty value removes it.
    pub open_food_facts_password: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Os3Update {
    pub enabled: Option<bool>,
    /// Missing preserves the existing cookie. An empty value removes it.
    pub session_cookie: Option<String>,
}

impl std::fmt::Debug for Os3Update {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Os3Update")
            .field("enabled", &self.enabled)
            .field("session_cookie_supplied", &self.session_cookie.is_some())
            .finish()
    }
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
    os3_status: RwLock<Os3Status>,
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
        // An observation Cosmos can make again, so an unreadable one is
        // simply not known yet rather than a reason to refuse to start.
        let mut os3_status = path
            .as_ref()
            .and_then(|path| fs::read(path.with_file_name(OS3_STATUS_FILE)).ok())
            .and_then(|bytes| serde_json::from_slice::<Os3Status>(&bytes).ok())
            .unwrap_or_default();
        let current_cookie = config.os3.session_cookie.as_deref().map(os3_cookie_digest);
        if os3_status.cookie_digest != current_cookie {
            os3_status = Os3Status {
                last_used_at_ms: os3_status.last_used_at_ms,
                ..Default::default()
            };
        }
        Ok(Arc::new(Self {
            config: RwLock::new(config),
            path,
            os3_status: RwLock::new(os3_status),
        }))
    }

    #[cfg(test)]
    pub fn memory(config: IntegrationsConfig) -> Arc<Self> {
        Arc::new(Self {
            config: RwLock::new(config),
            path: None,
            os3_status: RwLock::new(Os3Status::default()),
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
        apply_update(&mut next, update)?;
        normalize(&mut next);
        validate(&next)?;
        self.persist(&next)?;
        // What OS3 said about the old cookie says nothing about a new one.
        if next.os3.session_cookie != current.os3.session_cookie {
            self.change_os3_status(|status| {
                *status = Os3Status {
                    last_used_at_ms: status.last_used_at_ms,
                    ..Os3Status::default()
                };
            });
        }
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
        let bytes = serde_json::to_vec_pretty(config)
            .map_err(|_| IntegrationError::Invalid("configuration cannot be encoded"))?;
        write_owner_only(path, &bytes)?;
        Ok(())
    }

    /// What Cosmos last saw of the OS3 connection.
    pub fn os3_status(&self) -> Os3Status {
        self.os3_status
            .read()
            .expect("integration lock poisoned")
            .clone()
    }

    /// Record a contact with OS3 made with `cookie`: what it showed about the
    /// sign-in, and whether it was the assistant asking a question rather
    /// than a test. A contact made with a cookie the owner has since replaced
    /// says nothing about the new one, so it is not recorded.
    pub fn record_os3_contact(
        &self,
        cookie: &str,
        state: Os3State,
        butler_name: Option<String>,
        asked: bool,
    ) {
        // Held while recording, so a cookie saved meanwhile clears the status
        // after this contact, never before it (`update` takes the same order).
        let config = self.config.read().expect("integration lock poisoned");
        if config.os3.session_cookie.as_deref() != Some(cookie) {
            return;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or_default();
        self.change_os3_status(|status| {
            status.cookie_digest = Some(os3_cookie_digest(cookie));
            status.state = state;
            status.butler_name = butler_name.filter(|_| state == Os3State::Connected);
            status.checked_at_ms = Some(now);
            if asked {
                status.last_used_at_ms = Some(now);
            }
        });
        drop(config);
    }

    /// Change the status and keep it with the settings. It is an observation
    /// the next contact makes again, so a failed write is logged, not raised.
    fn change_os3_status(&self, change: impl FnOnce(&mut Os3Status)) {
        let mut status = self.os3_status.write().expect("integration lock poisoned");
        change(&mut status);
        let Some(path) = self.path.as_ref() else {
            return;
        };
        let written = serde_json::to_vec_pretty(&*status)
            .map_err(io::Error::other)
            .and_then(|bytes| write_owner_only(&path.with_file_name(OS3_STATUS_FILE), &bytes));
        if written.is_err() {
            tracing::warn!("the OS3 connection status could not be saved");
        }
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
            "COSMOS_LLM_API_KEY" => (config.assistant.provider
                == AssistantProvider::OpenAiCompatible)
                .then(|| config.assistant.api_key.clone())
                .flatten(),
            "COSMOS_LLM_MODEL" => optional(&config.assistant.model),
            "COSMOS_LLM_REASONING_EFFORT" => config.assistant.reasoning_effort.clone(),
            "COSMOS_LLM_MAX_TOKENS" => Some(config.assistant.max_tokens.to_string()),
            "COSMOS_SEARXNG_BASE_URL" => config.search.searxng_base_url.clone(),
            "COSMOS_SEARXNG_LANGUAGE" => config.search.searxng_language.clone(),
            "COSMOS_SERPAPI_KEY" => config.search.serpapi_key.clone(),
            "COSMOS_PPLX_API_KEY" => config.search.perplexity_api_key.clone(),
            "COSMOS_PPLX_MODEL" => config.search.perplexity_model.clone(),
            "COSMOS_WOLFRAM_APP_ID" => config.search.wolfram_app_id.clone(),
            "COSMOS_PIRATE_WEATHER_KEY" => config.search.weather_api_key.clone(),
            "COSMOS_GOOGLE_MAPS_KEY" => config.maps.google_maps_key.clone(),
            "COSMOS_AZURE_SPEECH_KEY" => config.speech.azure_key.clone(),
            "COSMOS_AZURE_SPEECH_REGION" => config.speech.azure_region.clone(),
            "COSMOS_AZURE_SPEECH_VOICE" => optional(&config.speech.azure_voice),
            "COSMOS_OPEN_FOOD_FACTS_USERNAME" => config.food.open_food_facts_username.clone(),
            "COSMOS_OPEN_FOOD_FACTS_PASSWORD" => config.food.open_food_facts_password.clone(),
            _ => return value_from_environment(name),
        };
        value.filter(|value| !value.trim().is_empty())
    }

    /// The OS3 session cookie, only while the owner has OS3 enabled.
    pub fn os3_session_cookie(&self) -> Option<String> {
        let config = self.config.read().expect("integration lock poisoned");
        config
            .os3
            .enabled
            .then(|| config.os3.session_cookie.clone())
            .flatten()
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

fn apply_update(
    config: &mut IntegrationsConfig,
    update: IntegrationsUpdate,
) -> Result<(), IntegrationError> {
    if let Some(update) = update.assistant {
        if let Some(name) = update.load_profile.as_deref() {
            let profile = config
                .assistant
                .profiles
                .iter()
                .find(|profile| profile.name == name)
                .cloned()
                .ok_or(IntegrationError::Invalid(
                    "that saved assistant profile no longer exists",
                ))?;
            config.assistant.load_profile(&profile);
        }
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
        if let Some(name) = update.delete_profile.as_deref() {
            config
                .assistant
                .profiles
                .retain(|profile| profile.name != name);
        }
        if let Some(name) = update.save_profile.map(|name| name.trim().to_owned()) {
            let saved = config.assistant.as_profile(name);
            match config
                .assistant
                .profiles
                .iter_mut()
                .find(|profile| profile.name == saved.name)
            {
                Some(existing) => *existing = saved,
                None => config.assistant.profiles.push(saved),
            }
        }
    }
    if let Some(update) = update.search {
        update_secret(&mut config.search.searxng_base_url, update.searxng_base_url);
        update_secret(&mut config.search.searxng_language, update.searxng_language);
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
    if let Some(update) = update.food {
        update_secret(
            &mut config.food.open_food_facts_username,
            update.open_food_facts_username,
        );
        update_secret(
            &mut config.food.open_food_facts_password,
            update.open_food_facts_password,
        );
    }
    if let Some(update) = update.os3 {
        if let Some(value) = update.enabled {
            config.os3.enabled = value;
        }
        update_secret(&mut config.os3.session_cookie, update.session_cookie);
    }
    Ok(())
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
    for profile in &mut config.assistant.profiles {
        profile.name = profile.name.trim().to_owned();
        profile.base_url = profile.base_url.trim().trim_end_matches('/').to_owned();
        profile.model = profile.model.trim().to_owned();
        profile.reasoning_effort = profile
            .reasoning_effort
            .take()
            .and_then(|value| optional(&value.to_ascii_lowercase()));
        profile.api_key = profile.api_key.take().and_then(|value| optional(&value));
    }
    config.speech.azure_voice = config.speech.azure_voice.trim().to_owned();
    // Accept a pasted `Cookie: ...` line as well as the bare header value.
    if let Some(cookie) = config.os3.session_cookie.take() {
        let cookie = cookie.trim();
        let value = match cookie.get(..7) {
            Some(name) if name.eq_ignore_ascii_case("cookie:") => &cookie[7..],
            _ => cookie,
        };
        config.os3.session_cookie = optional(value);
    }
    for value in [
        &mut config.assistant.api_key,
        &mut config.search.searxng_base_url,
        &mut config.search.searxng_language,
        &mut config.search.serpapi_key,
        &mut config.search.perplexity_api_key,
        &mut config.search.perplexity_model,
        &mut config.search.wolfram_app_id,
        &mut config.search.weather_api_key,
        &mut config.maps.google_maps_key,
        &mut config.speech.azure_key,
        &mut config.speech.azure_region,
        &mut config.food.open_food_facts_username,
        &mut config.food.open_food_facts_password,
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
    validate_assistant(&config.assistant.as_profile(String::new()))?;
    if config.assistant.profiles.len() > MAX_ASSISTANT_PROFILES {
        return Err(IntegrationError::Invalid(
            "too many saved assistant profiles",
        ));
    }
    for (index, profile) in config.assistant.profiles.iter().enumerate() {
        if profile.name.is_empty()
            || profile.name.chars().count() > MAX_ASSISTANT_PROFILE_NAME_CHARS
            || profile.name.chars().any(char::is_control)
        {
            return Err(IntegrationError::Invalid(
                "assistant profile name is invalid",
            ));
        }
        if config.assistant.profiles[..index]
            .iter()
            .any(|earlier| earlier.name == profile.name)
        {
            return Err(IntegrationError::Invalid(
                "assistant profile names must be unique",
            ));
        }
        validate_assistant(profile)?;
    }
    if let Some(url) = config.search.searxng_base_url.as_deref() {
        validate_url(url, "SearxNG URL is invalid")?;
    }
    if let Some(language) = config.search.searxng_language.as_deref()
        && !valid_searxng_language(language)
    {
        return Err(IntegrationError::Invalid("SearXNG language is invalid"));
    }
    for secret in [
        config.search.serpapi_key.as_deref(),
        config.search.perplexity_api_key.as_deref(),
        config.search.wolfram_app_id.as_deref(),
        config.search.weather_api_key.as_deref(),
        config.maps.google_maps_key.as_deref(),
        config.speech.azure_key.as_deref(),
        config.food.open_food_facts_username.as_deref(),
        config.food.open_food_facts_password.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if secret.len() > 8192 || secret.contains(['\r', '\n', '\0']) {
            return Err(IntegrationError::Invalid("credential is invalid"));
        }
    }
    if let Some(cookie) = config.os3.session_cookie.as_deref()
        && (cookie.len() > MAX_OS3_COOKIE_BYTES
            || !cookie.bytes().all(|byte| (b' '..=b'~').contains(&byte)))
    {
        return Err(IntegrationError::Invalid("OS3 session cookie is invalid"));
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

/// The checks every assistant profile passes, saved or in use.
fn validate_assistant(settings: &AssistantProfile) -> Result<(), IntegrationError> {
    if settings.model.is_empty() || settings.model.len() > 256 {
        return Err(IntegrationError::Invalid("assistant model is required"));
    }
    if settings.max_tokens > 65_536 {
        return Err(IntegrationError::Invalid(
            "assistant token limit is too large",
        ));
    }
    if let Some(effort) = settings.reasoning_effort.as_deref() {
        let supported = match settings.provider {
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
    if !settings.base_url.is_empty() {
        validate_url(&settings.base_url, "assistant URL is invalid")?;
    }
    if let Some(secret) = settings.api_key.as_deref()
        && (secret.len() > 8192 || secret.contains(['\r', '\n', '\0']))
    {
        return Err(IntegrationError::Invalid("credential is invalid"));
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

/// Replace `path` atomically with an owner-only file holding `bytes`.
pub(crate) fn write_owner_only(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().expect("state file has a parent");
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("json.new");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temporary, path)
}

fn os3_cookie_digest(cookie: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::new()
            .chain_update(b"luma.os3.status\0")
            .chain_update(cookie.as_bytes())
            .finalize()
    )
}

/// Whether `value` is a language tag SearXNG accepts for the `language`
/// request parameter and engines understand: a base tag (`en`, `da`) or a
/// base plus region/script parts (`en-US`, `zh-Hans-CN`). The deliberate
/// omission of `all` matches the settings.yml warning: engines map it to
/// arbitrary markets, which is the exact drift this setting exists to correct.
pub(crate) fn valid_searxng_language(value: &str) -> bool {
    // `all` is shape-valid but not a language: engines map it to arbitrary
    // markets, which is the exact drift this setting exists to correct.
    if value == "all" {
        return false;
    }
    let mut parts = value.split('-');
    let base = parts.next().unwrap_or_default();
    let base_ok =
        (2..=3).contains(&base.len()) && base.bytes().all(|byte| byte.is_ascii_lowercase());
    if !base_ok {
        return false;
    }
    parts.all(|part| {
        (2..=8).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
    })
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

    /// Real protected filesystem fixture, never owner configuration. Simulate
    /// restart after the config committed but the derived status file stayed
    /// stale. Its Connected observation must belong to the current cookie.
    #[test]
    fn os3_restart_does_not_attach_stale_contact_to_a_replacement_cookie() {
        use std::os::unix::fs::PermissionsExt;
        let directory =
            std::env::temp_dir().join(format!("luma-os3-status-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = IntegrationsConfig::default();
        config.os3.enabled = true;
        config.os3.session_cookie = Some("session=first-synthetic".to_owned());
        write_owner_only(
            &directory.join(CONFIG_FILE),
            &serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        let store = IntegrationStore::load(directory.to_str()).unwrap();
        store.record_os3_contact(
            "session=first-synthetic",
            Os3State::Connected,
            Some("First Butler".to_owned()),
            true,
        );
        let status_path = directory.join(OS3_STATUS_FILE);
        let stale = fs::read(&status_path).unwrap();
        assert_eq!(
            IntegrationStore::load(directory.to_str())
                .unwrap()
                .os3_status()
                .state,
            Os3State::Connected
        );
        store
            .update(IntegrationsUpdate {
                os3: Some(Os3Update {
                    session_cookie: Some("session=next-synthetic".to_owned()),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .unwrap();
        write_owner_only(&status_path, &stale).unwrap();
        drop(store);
        let restarted = IntegrationStore::load(directory.to_str()).unwrap();
        let status = restarted.os3_status();
        assert_eq!(status.state, Os3State::Untested);
        assert_eq!(status.butler_name, None);
        assert_eq!(status.checked_at_ms, None);
        assert!(status.last_used_at_ms.is_some());
        restarted.record_os3_contact(
            "session=next-synthetic",
            Os3State::Connected,
            Some("Next Butler".to_owned()),
            false,
        );
        assert_eq!(
            IntegrationStore::load(directory.to_str())
                .unwrap()
                .os3_status()
                .butler_name
                .as_deref(),
            Some("Next Butler")
        );
        fs::remove_dir_all(directory).unwrap();
    }

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
        )
        .unwrap();
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
        )
        .unwrap();
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
    fn os3_cookie_is_a_secret_offered_only_while_enabled() {
        let before_os3 = r#"{"schema_version":1,"food":{"open_food_facts_username":"user"}}"#;
        let stored: IntegrationsConfig = serde_json::from_str(before_os3).unwrap();
        assert!(!stored.os3.enabled && stored.os3.session_cookie.is_none());

        let store = IntegrationStore::memory(stored);
        let mut next = store.snapshot();
        apply_update(
            &mut next,
            IntegrationsUpdate {
                os3: Some(Os3Update {
                    session_cookie: Some("  Cookie: session=private-os3-cookie  ".to_owned()),
                    ..Os3Update::default()
                }),
                ..IntegrationsUpdate::default()
            },
        )
        .unwrap();
        normalize(&mut next);
        validate(&next).unwrap();
        assert_eq!(
            next.os3.session_cookie.as_deref(),
            Some("session=private-os3-cookie")
        );
        assert!(
            !next.os3.configured(),
            "a stored cookie alone is not opt-in"
        );
        assert!(!format!("{next:?}").contains("private-os3-cookie"));

        apply_update(
            &mut next,
            IntegrationsUpdate {
                os3: Some(Os3Update {
                    enabled: Some(true),
                    ..Os3Update::default()
                }),
                ..IntegrationsUpdate::default()
            },
        )
        .unwrap();
        assert!(next.os3.configured(), "omitting the cookie keeps it");
        let enabled = IntegrationStore::memory(next.clone());
        assert_eq!(
            enabled.os3_session_cookie().as_deref(),
            Some("session=private-os3-cookie")
        );

        let removal = Os3Update {
            session_cookie: Some(String::new()),
            ..Os3Update::default()
        };
        assert!(!format!("{removal:?}").contains("private"));
        apply_update(
            &mut next,
            IntegrationsUpdate {
                os3: Some(removal),
                ..IntegrationsUpdate::default()
            },
        )
        .unwrap();
        assert_eq!(next.os3.session_cookie, None);
        assert!(!next.os3.configured());

        next.os3.session_cookie = Some("session=a\u{7f}".to_owned());
        assert!(validate(&next).is_err());
        next.os3.session_cookie = Some("x".repeat(MAX_OS3_COOKIE_BYTES + 1));
        assert!(validate(&next).is_err());
    }

    #[test]
    fn switching_saved_profiles_restores_their_settings_and_keys() {
        let mut config = IntegrationsConfig::default();
        config.assistant.base_url = "https://gateway.example.test/v1".to_owned();
        config.assistant.api_key = Some("gateway-key".to_owned());
        config.assistant.model = "gateway/default".to_owned();
        let store = IntegrationStore::memory(config);
        assert_eq!(store.snapshot().assistant.active_profile(), None);

        // Name the settings in use, then save a Codex profile beside them.
        let mut next = store.snapshot();
        apply_update(
            &mut next,
            IntegrationsUpdate {
                assistant: Some(AssistantUpdate {
                    save_profile: Some("  Gateway ".to_owned()),
                    ..AssistantUpdate::default()
                }),
                ..IntegrationsUpdate::default()
            },
        )
        .unwrap();
        apply_update(
            &mut next,
            IntegrationsUpdate {
                assistant: Some(AssistantUpdate {
                    provider: Some(AssistantProvider::CodexSubscription),
                    model: Some("gpt-5.6-sol".to_owned()),
                    reasoning_effort: Some("high".to_owned()),
                    fast_mode: Some(true),
                    save_profile: Some("Codex".to_owned()),
                    ..AssistantUpdate::default()
                }),
                ..IntegrationsUpdate::default()
            },
        )
        .unwrap();
        normalize(&mut next);
        validate(&next).unwrap();
        assert_eq!(
            next.assistant.provider,
            AssistantProvider::CodexSubscription
        );
        assert_eq!(next.assistant.active_profile(), Some("Codex"));
        let codex = next
            .assistant
            .profiles
            .iter()
            .find(|p| p.name == "Codex")
            .unwrap();
        assert!(
            codex.api_key.is_none() && codex.base_url.is_empty(),
            "a Codex profile carries no OpenAI-compatible credential"
        );

        // Switching back restores the URL, the key and the model untyped.
        apply_update(
            &mut next,
            IntegrationsUpdate {
                assistant: Some(AssistantUpdate {
                    load_profile: Some("Gateway".to_owned()),
                    provider: Some(AssistantProvider::OpenAiCompatible),
                    base_url: Some("https://gateway.example.test/v1".to_owned()),
                    model: Some("gateway/default".to_owned()),
                    save_profile: Some("Gateway".to_owned()),
                    ..AssistantUpdate::default()
                }),
                ..IntegrationsUpdate::default()
            },
        )
        .unwrap();
        normalize(&mut next);
        validate(&next).unwrap();
        assert_eq!(next.assistant.api_key.as_deref(), Some("gateway-key"));
        assert_eq!(next.assistant.model, "gateway/default");
        assert_eq!(next.assistant.reasoning_effort, None);
        assert!(!next.assistant.fast_mode);
        assert_eq!(next.assistant.active_profile(), Some("Gateway"));
        assert!(next.assistant.configured());

        // Saving under a new name keeps the one it started from.
        apply_update(
            &mut next,
            IntegrationsUpdate {
                assistant: Some(AssistantUpdate {
                    load_profile: Some("Gateway".to_owned()),
                    model: Some("gateway/fast".to_owned()),
                    save_profile: Some("Gateway fast".to_owned()),
                    ..AssistantUpdate::default()
                }),
                ..IntegrationsUpdate::default()
            },
        )
        .unwrap();
        let names: Vec<&str> = next
            .assistant
            .profiles
            .iter()
            .map(|p| p.name.as_str())
            .collect();
        assert_eq!(names, ["Gateway", "Codex", "Gateway fast"]);
        assert_eq!(next.assistant.active_profile(), Some("Gateway fast"));

        // Deleting a profile leaves the settings in use alone.
        apply_update(
            &mut next,
            IntegrationsUpdate {
                assistant: Some(AssistantUpdate {
                    delete_profile: Some("Gateway fast".to_owned()),
                    ..AssistantUpdate::default()
                }),
                ..IntegrationsUpdate::default()
            },
        )
        .unwrap();
        assert_eq!(next.assistant.model, "gateway/fast");
        assert_eq!(next.assistant.active_profile(), None);
        assert!(
            apply_update(
                &mut next,
                IntegrationsUpdate {
                    assistant: Some(AssistantUpdate {
                        load_profile: Some("Gateway fast".to_owned()),
                        ..AssistantUpdate::default()
                    }),
                    ..IntegrationsUpdate::default()
                },
            )
            .is_err(),
            "a deleted profile cannot be loaded"
        );

        // Names are unique and bounded; a saved key is a secret like any other.
        next.assistant
            .profiles
            .push(next.assistant.profiles[0].clone());
        assert!(validate(&next).is_err());
        next.assistant.profiles.pop();
        next.assistant.profiles[0].api_key = Some("bad\nkey".to_owned());
        assert!(validate(&next).is_err());
        next.assistant.profiles[0].api_key = Some("gateway-key".to_owned());
        next.assistant.profiles[0].name = "x".repeat(MAX_ASSISTANT_PROFILE_NAME_CHARS + 1);
        assert!(validate(&next).is_err());

        // A file saved before any profile existed still loads unchanged.
        let before = r#"{"schema_version":1,"assistant":{"provider":"openai-compatible","base_url":"https://a.test/v1","api_key":"k","model":"m","reasoning_effort":null,"fast_mode":false,"max_tokens":512}}"#;
        let stored: IntegrationsConfig = serde_json::from_str(before).unwrap();
        assert!(stored.assistant.profiles.is_empty());
        assert!(!serde_json::to_string(&stored).unwrap().contains("profiles"));
    }
}
