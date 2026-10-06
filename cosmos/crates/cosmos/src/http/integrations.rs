//! Operator integrations: the assistant, search, maps, speech, food and OS3
//! provider settings Center edits, their live tests, and the Codex sign-in.

use super::*;

#[derive(Serialize)]
pub(super) struct IntegrationsView {
    assistant: AssistantIntegrationView,
    search: SearchIntegrationView,
    maps: MapsIntegrationView,
    speech: SpeechIntegrationView,
    food: FoodIntegrationView,
    os3: Os3IntegrationView,
}

#[derive(Serialize)]
struct AssistantIntegrationView {
    provider: crate::integrations::AssistantProvider,
    configured: bool,
    base_url: String,
    api_key_configured: bool,
    model: String,
    reasoning_effort: Option<String>,
    fast_mode: bool,
    max_tokens: u32,
    codex: crate::assistant::codex_app_server::CodexAccountStatus,
    /// The saved profile whose settings are in use, if any.
    profile: Option<String>,
    profiles: Vec<AssistantProfileView>,
}

/// A saved assistant profile as Center lists it: its settings, and whether
/// it holds a key, never the key.
#[derive(Serialize)]
struct AssistantProfileView {
    name: String,
    provider: crate::integrations::AssistantProvider,
    base_url: String,
    api_key_configured: bool,
    model: String,
    reasoning_effort: Option<String>,
    fast_mode: bool,
    max_tokens: u32,
}

#[derive(Serialize)]
struct SearchIntegrationView {
    configured: bool,
    searxng_base_url: Option<String>,
    serpapi_key_configured: bool,
    perplexity_key_configured: bool,
    perplexity_model: Option<String>,
    wolfram_configured: bool,
    weather_configured: bool,
}

#[derive(Serialize)]
struct MapsIntegrationView {
    configured: bool,
}

#[derive(Serialize)]
struct SpeechIntegrationView {
    configured: bool,
    azure_key_configured: bool,
    azure_region: Option<String>,
    azure_voice: String,
}

#[derive(Serialize)]
struct FoodIntegrationView {
    configured: bool,
    username_configured: bool,
    password_configured: bool,
}

#[derive(Serialize)]
struct Os3IntegrationView {
    enabled: bool,
    configured: bool,
    session_cookie_configured: bool,
    /// What the last test or question showed: `not_configured`, `untested`,
    /// `connected` (only when it went through), or the step that failed:
    /// `sign_in_expired`, `blocked`, `no_instance`, `socket_refused`,
    /// `unavailable`, `dropped`, or `timed_out`.
    status: &'static str,
    /// OS3's display name for the agent while connected. Never the account
    /// email.
    butler_name: Option<String>,
    /// Unix milliseconds of the last contact with OS3.
    checked_at_ms: Option<u64>,
    /// Unix milliseconds of the last question the assistant asked OS3.
    last_used_at_ms: Option<u64>,
}

impl Os3IntegrationView {
    pub(super) fn new(
        config: &crate::integrations::Os3Config,
        status: crate::integrations::Os3Status,
    ) -> Self {
        use crate::integrations::Os3State;
        // Switched off or without a cookie, OS3 is not configured, whatever
        // it said last.
        let configured = config.configured();
        let state = configured.then_some(status.state);
        Self {
            enabled: config.enabled,
            configured,
            session_cookie_configured: config.session_cookie.is_some(),
            status: match state {
                None => "not_configured",
                Some(Os3State::Untested) => "untested",
                Some(Os3State::Connected) => "connected",
                Some(Os3State::SignInExpired) => "sign_in_expired",
                Some(Os3State::Blocked) => "blocked",
                Some(Os3State::NoInstance) => "no_instance",
                Some(Os3State::SocketRefused) => "socket_refused",
                Some(Os3State::Unavailable) => "unavailable",
                Some(Os3State::Dropped) => "dropped",
                Some(Os3State::TimedOut) => "timed_out",
            },
            butler_name: status
                .butler_name
                .filter(|_| state == Some(Os3State::Connected)),
            checked_at_ms: status.checked_at_ms,
            last_used_at_ms: status.last_used_at_ms,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum IntegrationTestTarget {
    Assistant,
    Searxng,
    Serpapi,
    Perplexity,
    Maps,
    Weather,
    Wolfram,
    Speech,
    OpenFoodFacts,
    Os3,
}

impl IntegrationTestTarget {
    pub(super) fn configured(self, config: &crate::integrations::IntegrationsConfig) -> bool {
        match self {
            Self::Assistant => config.assistant.configured(),
            Self::Searxng => config.search.searxng_base_url.is_some(),
            Self::Serpapi => config.search.serpapi_key.is_some(),
            Self::Perplexity => config.search.perplexity_api_key.is_some(),
            Self::Maps => config.maps.google_maps_key.is_some(),
            Self::Weather => config.search.weather_api_key.is_some(),
            Self::Wolfram => config.search.wolfram_app_id.is_some(),
            Self::Speech => {
                config.speech.azure_key.is_some() && config.speech.azure_region.is_some()
            }
            Self::OpenFoodFacts => config.food.configured(),
            Self::Os3 => config.os3.configured(),
        }
    }

    pub(super) fn success_message(self) -> &'static str {
        match self {
            Self::Assistant => "Assistant and photo understanding are working.",
            Self::Searxng => "SearXNG returned search results.",
            Self::Serpapi => "SerpApi returned search results.",
            Self::Perplexity => "Perplexity answered successfully.",
            Self::Maps => "Google Maps returned nearby places and a route.",
            Self::Weather => "Pirate Weather returned current conditions.",
            Self::Wolfram => "Wolfram|Alpha answered successfully.",
            Self::Speech => "Azure Speech returned audio.",
            Self::OpenFoodFacts => "Open Food Facts sign-in succeeded.",
            // When OS3 names the agent, the test says "Connected to OS3 as …".
            Self::Os3 => "Connected to OS3.",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct IntegrationTestRequest {
    pub(super) target: IntegrationTestTarget,
}

#[derive(Serialize)]
pub(super) struct IntegrationTestView {
    ok: bool,
    message: String,
}

/// Center's OS3 test: whom OS3 connected as, or what the owner does next.
async fn os3_integration_test(
    connected: &'static str,
) -> Result<Json<IntegrationTestView>, DemoError> {
    match crate::backends::os3::probe().await {
        Ok(name) => Ok(Json(IntegrationTestView {
            ok: true,
            message: if name.is_empty() {
                connected.to_owned()
            } else {
                format!("Connected to OS3 as {name}.")
            },
        })),
        Err(error) => Err(os3_test_failure(error)),
    }
}

/// A failed OS3 test names the step that failed and what the owner does next.
fn os3_test_failure(error: crate::backends::os3::Os3Error) -> DemoError {
    use crate::backends::os3::Os3Error;
    match error {
        Os3Error::SignInExpired => demo_error(
            StatusCode::BAD_GATEWAY,
            "The OS3 sign-in has expired. Sign in at os3.rabbit.tech again and paste a fresh \
             session cookie.",
        ),
        Os3Error::Blocked => demo_error(
            StatusCode::BAD_GATEWAY,
            "Rabbit's edge network blocked the connection (HTTP 403) before OS3 checked the \
             sign-in, so the cookie was not the problem. Try again later.",
        ),
        Os3Error::NoInstance => demo_error(
            StatusCode::BAD_GATEWAY,
            "OS3 accepted the sign-in but named no instance for this account. Try again in a \
             moment.",
        ),
        Os3Error::SocketRefused => demo_error(
            StatusCode::BAD_GATEWAY,
            "OS3 accepted the sign-in, but its conversation socket refused the connection or \
             closed before it opened. Try again in a moment.",
        ),
        Os3Error::NotConfigured => demo_error(
            StatusCode::CONFLICT,
            "OS3 is not configured. Turn on Use OS3, paste a session cookie, and save.",
        ),
        Os3Error::ConfigurationChanged | Os3Error::Superseded => {
            demo_error(StatusCode::CONFLICT, error.observation())
        }
        Os3Error::Busy => demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "OS3 is answering another question. Try again in a moment.",
        ),
        Os3Error::NoAnswer => demo_error(
            StatusCode::GATEWAY_TIMEOUT,
            "OS3 did not respond in time. Try again in a moment.",
        ),
        Os3Error::Unavailable => demo_error(
            StatusCode::BAD_GATEWAY,
            "OS3 could not be reached. Try again in a moment.",
        ),
        Os3Error::Dropped => demo_error(
            StatusCode::BAD_GATEWAY,
            "The connection to OS3 dropped. Try again in a moment.",
        ),
        Os3Error::ConversationStorage => demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Luma could not read or save its OS3 conversation. Check Luma with ./luma doctor \
             production.",
        ),
    }
}

async fn maps_integration_test(
    working: &'static str,
) -> Result<Json<IntegrationTestView>, DemoError> {
    const COPENHAGEN: (f64, f64) = (55.6761, 12.5683);
    let test = async {
        crate::backends::places::nearby("coffee", Some(COPENHAGEN), 1_000.0)
            .await
            .map_err(|error| maps_test_failure(MapsApi::Places, error))?;
        // A bare place name, as a wearer says it, must resolve to the Nyhavn
        // near the Pin. A route counts only when it has steps.
        crate::backends::places::directions(
            COPENHAGEN.0,
            COPENHAGEN.1,
            "Nyhavn".to_owned(),
            Some(crate::backends::places::DirectionsMode::Walking),
        )
        .await
        .map_err(|error| maps_test_failure(MapsApi::Routes, error))?;
        Ok(Json(IntegrationTestView {
            ok: true,
            message: working.to_owned(),
        }))
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), test)
        .await
        .unwrap_or_else(|_| {
            Err(demo_error(
                StatusCode::GATEWAY_TIMEOUT,
                "The provider test timed out.",
            ))
        })
}

#[derive(Clone, Copy)]
enum MapsApi {
    Places,
    Routes,
}

fn maps_test_failure(api: MapsApi, error: crate::backends::BackendError) -> DemoError {
    use crate::backends::BackendError;
    let message = match (api, error) {
        (MapsApi::Places, BackendError::NotConfigured) => {
            "Google refused this key for place search. Enable Places API (New) for the key \
             in Google Cloud Console, then test again."
        }
        (MapsApi::Routes, BackendError::NotConfigured) => {
            "Place search works, but Google refused this key for directions. Enable the \
             Routes API for the key in Google Cloud Console, then test again."
        }
        (MapsApi::Places, _) => {
            "Google Maps did not answer a test place search. Check the key and try again."
        }
        (MapsApi::Routes, _) => {
            "Place search works, but Google Maps did not return a test route. Try again in a \
             moment."
        }
    };
    demo_error(StatusCode::BAD_GATEWAY, message)
}

fn weather_integration_result_is_renderable(
    result: Result<cosmos_protocol::aibus::WeatherResponse, crate::backends::BackendError>,
) -> bool {
    result.is_ok_and(|weather| {
        crate::backends::weather::stock_weather_response_is_renderable(&weather)
    })
}

pub(super) async fn integrations_view(
    config: crate::integrations::IntegrationsConfig,
    os3_status: crate::integrations::Os3Status,
) -> IntegrationsView {
    let codex =
        if config.assistant.provider == crate::integrations::AssistantProvider::CodexSubscription {
            crate::assistant::codex_app_server::account_status().await
        } else {
            crate::assistant::codex_app_server::CodexAccountStatus {
                available: std::path::Path::new(
                    &std::env::var("COSMOS_CODEX_BIN")
                        .unwrap_or_else(|_| "/opt/codex/bin/codex".to_owned()),
                )
                .is_file(),
                connected: false,
                plan: None,
                email: None,
            }
        };
    let assistant_configured = match config.assistant.provider {
        crate::integrations::AssistantProvider::OpenAiCompatible => config.assistant.configured(),
        crate::integrations::AssistantProvider::CodexSubscription => {
            config.assistant.configured() && codex.connected
        }
    };
    let profile = config.assistant.active_profile().map(str::to_owned);
    let profiles = config
        .assistant
        .profiles
        .iter()
        .map(|profile| AssistantProfileView {
            name: profile.name.clone(),
            provider: profile.provider,
            base_url: profile.base_url.clone(),
            api_key_configured: profile.api_key.is_some(),
            model: profile.model.clone(),
            reasoning_effort: profile.reasoning_effort.clone(),
            fast_mode: profile.fast_mode,
            max_tokens: profile.max_tokens,
        })
        .collect();
    IntegrationsView {
        assistant: AssistantIntegrationView {
            provider: config.assistant.provider,
            configured: assistant_configured,
            base_url: config.assistant.base_url,
            api_key_configured: config.assistant.api_key.is_some(),
            model: config.assistant.model,
            reasoning_effort: config.assistant.reasoning_effort,
            fast_mode: config.assistant.fast_mode,
            max_tokens: config.assistant.max_tokens,
            codex,
            profile,
            profiles,
        },
        search: SearchIntegrationView {
            configured: config.search.searxng_base_url.is_some()
                || config.search.serpapi_key.is_some(),
            searxng_base_url: config.search.searxng_base_url,
            serpapi_key_configured: config.search.serpapi_key.is_some(),
            perplexity_key_configured: config.search.perplexity_api_key.is_some(),
            perplexity_model: config.search.perplexity_model,
            wolfram_configured: config.search.wolfram_app_id.is_some(),
            weather_configured: config.search.weather_api_key.is_some(),
        },
        maps: MapsIntegrationView {
            configured: config.maps.google_maps_key.is_some(),
        },
        speech: SpeechIntegrationView {
            configured: config.speech.azure_key.is_some() && config.speech.azure_region.is_some(),
            azure_key_configured: config.speech.azure_key.is_some(),
            azure_region: config.speech.azure_region,
            azure_voice: config.speech.azure_voice,
        },
        food: FoodIntegrationView {
            configured: config.food.configured(),
            username_configured: config.food.open_food_facts_username.is_some(),
            password_configured: config.food.open_food_facts_password.is_some(),
        },
        os3: Os3IntegrationView::new(&config.os3, os3_status),
    }
}

pub(super) async fn admin_integrations(
    headers: HeaderMap,
    State(state): State<HttpState>,
) -> Result<Json<IntegrationsView>, DemoError> {
    require_admin(&headers)?;
    Ok(Json(
        integrations_view(
            state.integrations.snapshot(),
            state.integrations.os3_status(),
        )
        .await,
    ))
}

pub(super) async fn update_integrations(
    headers: HeaderMap,
    State(state): State<HttpState>,
    Json(update): Json<crate::integrations::IntegrationsUpdate>,
) -> Result<Json<IntegrationsView>, DemoError> {
    require_admin(&headers)?;
    let config = state
        .integrations
        .update(update)
        .map_err(|error| match error {
            crate::integrations::IntegrationError::Invalid(message) => {
                demo_error(StatusCode::BAD_REQUEST, message)
            }
            crate::integrations::IntegrationError::Persistence(_) => demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Integration settings could not be saved.",
            ),
        })?;
    Ok(Json(
        integrations_view(config, state.integrations.os3_status()).await,
    ))
}

pub(super) async fn test_integration(
    headers: HeaderMap,
    State(state): State<HttpState>,
    Json(request): Json<IntegrationTestRequest>,
) -> Result<Json<IntegrationTestView>, DemoError> {
    use crate::backends::azure_speech::{
        AzureSpeechClient, SpeechAudioFormat, SpeechSynthesisBackend,
    };

    require_admin(&headers)?;
    let config = state.integrations.snapshot();
    if !request.target.configured(&config) {
        return Err(demo_error(
            StatusCode::CONFLICT,
            "Save this provider's settings before testing it.",
        ));
    }
    let message = request.target.success_message();
    let test: std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>> = match request
        .target
    {
        IntegrationTestTarget::Assistant => Box::pin(async move {
            let image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=".to_owned();
            crate::assistant::vision::complete(
                "This is a connection test. Reply with OK.",
                &[image],
                crate::assistant::vision::BACKGROUND_LIMIT,
            )
            .await
            .is_ok_and(|answer| !answer.trim().is_empty())
        }),
        IntegrationTestTarget::Searxng => {
            Box::pin(async { crate::backends::search::probe_searxng().await.is_ok() })
        }
        IntegrationTestTarget::Serpapi => {
            Box::pin(async { crate::backends::search::probe_serpapi().await.is_ok() })
        }
        IntegrationTestTarget::Perplexity => Box::pin(async {
            crate::backends::perplexity::ask("Reply with OK.")
                .await
                .is_ok()
        }),
        // Both Google APIs the Pin uses: a place search, then a route. Each
        // failure names the API the owner enables for the key.
        IntegrationTestTarget::Maps => return maps_integration_test(message).await,
        IntegrationTestTarget::Weather => Box::pin(async {
            weather_integration_result_is_renderable(
                crate::backends::weather::current(55.6761, 12.5683).await,
            )
        }),
        IntegrationTestTarget::Wolfram => {
            Box::pin(async { crate::backends::wolfram::query("2 + 2").await.is_ok() })
        }
        IntegrationTestTarget::Speech => Box::pin(async {
            let Ok(Some(client)) = AzureSpeechClient::from_configuration() else {
                return false;
            };
            client
                .synthesize("Cosmos is ready.", SpeechAudioFormat::Raw24Khz16BitMonoPcm)
                .await
                .is_ok()
        }),
        IntegrationTestTarget::OpenFoodFacts => Box::pin(async move {
            let (Some(username), Some(password)) = (
                config.food.open_food_facts_username,
                config.food.open_food_facts_password,
            ) else {
                return false;
            };
            crate::backends::food::authenticate(&username, &password)
                .await
                .is_ok()
        }),
        // Sign in, route, and initialize without asking OS3 anything, then
        // say whom OS3 connected as, or exactly what the owner does next. The
        // probe bounds itself inside Center's wait.
        IntegrationTestTarget::Os3 => return os3_integration_test(message).await,
    };
    match tokio::time::timeout(std::time::Duration::from_secs(30), test).await {
        Ok(true) => Ok(Json(IntegrationTestView {
            ok: true,
            message: message.to_owned(),
        })),
        Ok(false) => Err(demo_error(
            StatusCode::BAD_GATEWAY,
            "The provider did not complete the test request. Check its credential and settings.",
        )),
        Err(_) => Err(demo_error(
            StatusCode::GATEWAY_TIMEOUT,
            "The provider test timed out.",
        )),
    }
}

pub(super) async fn start_codex_login(
    headers: HeaderMap,
) -> Result<Json<crate::assistant::codex_app_server::CodexDeviceCode>, DemoError> {
    require_admin(&headers)?;
    crate::assistant::codex_app_server::start_device_login()
        .await
        .map(Json)
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Codex sign-in could not be started.",
            )
        })
}

pub(super) async fn logout_codex(headers: HeaderMap) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    crate::assistant::codex_app_server::logout()
        .await
        .map(|_| Json(serde_json::json!({ "ok": true })))
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Codex could not be disconnected.",
            )
        })
}
