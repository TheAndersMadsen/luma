//! Stock: ironman/sources/humaneinternal/system/aibus/AIBusClient.java

use std::pin::Pin;
use std::sync::Arc;

use tokio::sync::{broadcast, Mutex, RwLock};
use tokio_stream::Stream;
use tonic::{Request, Response, Status};

use self::capabilities::food::FoodHandler;
use self::capabilities::navigation::NavigationDirectionsHandler;
use self::capabilities::smart_playlist::SmartPlaylistHandler;
use self::completion::CompletionHandler;
use self::cue::interstitial::ActionInterstitialHandler;
use self::cue::loading_message::LoadingMessageHandler;
use self::geolocate::GeoLocateHandler;
use self::nearby::NearbySearchHandler;
use self::reverse_geocode::ReverseGeocodeHandler;
use self::stubs::StubHandler;
use self::turn::orchestration::AgenticExternalClients;
use self::understand::UnderstandHandler;
use self::vision::VisionHandler;
use self::weather::WeatherHandler;
use crate::config::{Config, ResolvedConfig};
use crate::db::Database;
use crate::external::google_maps::GoogleMapsClient;
use crate::external::open_food_facts::OpenFoodFactsClient;
use crate::llm::memory::MemoryService;
use crate::llm::LlmAgent;
use crate::nearby::NearbyClient;
use crate::proto::aibus::ai_bus_service_server::AiBusService;
use crate::proto::aibus::*;
use crate::spotify::SpotifyService;
use crate::storage::MediaStore;
use crate::synapse::image_store::LiveImageStore;

mod capabilities;
mod completion;
mod cue;
mod envelope;
mod geolocate;
mod nearby;
mod reverse_geocode;
mod stock_deadline;
mod stubs;
mod supervisor_prompt;
mod tools;
mod turn;
mod understand;
mod vision;
mod weather;

pub use capabilities::composition::CompositionServiceImpl;
pub(crate) use capabilities::food::FoodRuntimeGate;
pub use stubs::{UploadFileHandler, UploadTicketError};
pub use tools::execution::FunctionExecutionHandler;

#[derive(Clone)]
pub struct AiBus {
    handlers: Arc<RwLock<Arc<AiBusHanders>>>,
    function_execution: FunctionExecutionHandler,
    upload_file: UploadFileHandler,
}

impl AiBus {
    /// Construct the service with explicitly configured external clients.
    /// Production wiring can opt providers in here; [`Self::new`] keeps every
    /// newly added provider disabled by default.
    // Dependency-injection constructor: each argument is a distinct collaborator,
    // not a cohesive group worth bundling into a struct.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_external_clients(
        agent: Arc<LlmAgent>,
        config: Arc<ResolvedConfig>,
        live_config: Arc<RwLock<Config>>,
        nearby_client: NearbyClient,
        http_client: reqwest::Client,
        db: Database,
        memory: Option<MemoryService>,
        store: Arc<Mutex<MediaStore>>,
        events_tx: broadcast::Sender<crate::api::Event>,
        external_clients: AiBusExternalClients,
    ) -> Self {
        let function_execution = FunctionExecutionHandler::new(store, events_tx);
        let handlers = AiBusHanders::new_with_external_clients(
            agent,
            config,
            live_config,
            nearby_client,
            http_client,
            db,
            memory,
            external_clients,
        )
        .with_function_execution(function_execution.clone());
        Self {
            handlers: Arc::new(RwLock::new(Arc::new(handlers))),
            function_execution,
            upload_file: UploadFileHandler::default(),
        }
    }

    /// Install the process-lifetime UploadFile handler. Unlike the provider
    /// handler set, this state is not replaced during dashboard config reloads,
    /// so already-issued one-time upload URLs remain consumable until expiry.
    pub fn with_upload_file_handler(mut self, handler: UploadFileHandler) -> Self {
        self.upload_file = handler;
        self
    }

    pub async fn replace(&self, next: Arc<AiBusHanders>) {
        let mut current = self.handlers.write().await;
        *current = next;
    }

    async fn handlers(&self) -> Arc<AiBusHanders> {
        self.handlers.read().await.clone()
    }

    pub fn function_execution_handler(&self) -> FunctionExecutionHandler {
        self.function_execution.clone()
    }
}

#[tonic::async_trait]
impl AiBusService for AiBus {
    type UnderstandStream =
        Pin<Box<dyn Stream<Item = Result<SynapseUnderstandingResponse, Status>> + Send>>;
    type BidirectionalStreamingUnderstandStream =
        Pin<Box<dyn Stream<Item = Result<StreamingUnderstandResponse, Status>> + Send>>;
    type EncryptedStreamAIBusStream =
        Pin<Box<dyn Stream<Item = Result<EncryptedAiResponse, Status>> + Send>>;
    type EncryptedUnderstandStream =
        Pin<Box<dyn Stream<Item = Result<EncryptedSynapseUnderstandingResponse, Status>> + Send>>;

    async fn upload_file(
        &self,
        request: Request<UploadFileRequest>,
    ) -> Result<Response<UploadFileResponse>, Status> {
        self.upload_file.upload_file(request).await
    }

    async fn understand(
        &self,
        request: Request<SynapseUnderstandingRequest>,
    ) -> Result<Response<Self::UnderstandStream>, Status> {
        self.handlers().await.understand.understand(request).await
    }

    async fn analyze_image(
        &self,
        request: Request<AnalyzeImageRequest>,
    ) -> Result<Response<AnalyzeImageResponse>, Status> {
        self.handlers().await.vision.analyze_image(request).await
    }

    async fn function_execution(
        &self,
        request: Request<FunctionCall>,
    ) -> Result<Response<FunctionResponse>, Status> {
        self.function_execution.function_execution(request).await
    }

    async fn server_stateful_understand(
        &self,
        request: Request<ServerStatefulUnderstandRequest>,
    ) -> Result<Response<ServerStatefulUnderstandResponse>, Status> {
        self.handlers()
            .await
            .stubs
            .server_stateful_understand(request)
            .await
    }

    async fn bidirectional_streaming_understand(
        &self,
        request: Request<tonic::Streaming<StreamingUnderstandRequest>>,
    ) -> Result<Response<Self::BidirectionalStreamingUnderstandStream>, Status> {
        turn::streaming::bidirectional_streaming_understand(self.handlers().await, request).await
    }

    async fn encrypted_stream_ai_bus(
        &self,
        request: Request<tonic::Streaming<EncryptedAiRequest>>,
    ) -> Result<Response<Self::EncryptedStreamAIBusStream>, Status> {
        self.handlers()
            .await
            .stubs
            .encrypted_stream_ai_bus(request)
            .await
    }

    async fn encrypted_understand(
        &self,
        request: Request<EncryptedSynapseUnderstandingRequest>,
    ) -> Result<Response<Self::EncryptedUnderstandStream>, Status> {
        self.handlers()
            .await
            .understand
            .encrypted_understand(request)
            .await
    }

    async fn encrypted_loading_message(
        &self,
        request: Request<EncryptedLoadingMessageRequest>,
    ) -> Result<Response<EncryptedLoadingMessageResponse>, Status> {
        self.handlers()
            .await
            .loading_message
            .encrypted_loading_message(request)
            .await
    }

    async fn encrypted_nearby_search(
        &self,
        request: Request<EncryptedNearbySearchRequest>,
    ) -> Result<Response<EncryptedNearbySearchResponse>, Status> {
        self.handlers()
            .await
            .nearby
            .encrypted_nearby_search(request)
            .await
    }

    async fn encrypted_navigation_directions(
        &self,
        request: Request<EncryptedNavigationDirectionsRequest>,
    ) -> Result<Response<EncryptedNavigationDirectionsResponse>, Status> {
        self.handlers()
            .await
            .navigation
            .encrypted_navigation_directions(request)
            .await
    }

    async fn encrypted_chat_completion(
        &self,
        request: Request<EncryptedChatCompletionRequest>,
    ) -> Result<Response<EncryptedChatCompletionResponse>, Status> {
        self.handlers()
            .await
            .completion
            .encrypted_chat_completion(request)
            .await
    }

    async fn encrypted_completion(
        &self,
        request: Request<EncryptedCompletionRequest>,
    ) -> Result<Response<EncryptedCompletionResponse>, Status> {
        self.handlers()
            .await
            .completion
            .encrypted_completion(request)
            .await
    }

    async fn encrypted_geo_locate(
        &self,
        request: Request<EncryptedGeoLocateRequest>,
    ) -> Result<Response<EncryptedGeoLocateResponse>, Status> {
        self.handlers()
            .await
            .geolocate
            .encrypted_geo_locate(request)
            .await
    }

    async fn encrypted_smart_playlist(
        &self,
        request: Request<EncryptedSmartPlaylistRequest>,
    ) -> Result<Response<EncryptedSmartPlaylistResponse>, Status> {
        self.handlers()
            .await
            .smart_playlist
            .encrypted_smart_playlist(request)
            .await
    }

    async fn encrypted_weather(
        &self,
        request: Request<EncryptedWeatherRequest>,
    ) -> Result<Response<EncryptedWeatherResponse>, Status> {
        self.handlers()
            .await
            .weather
            .encrypted_weather(request)
            .await
    }

    async fn encrypted_reverse_geocode(
        &self,
        request: Request<EncryptedReverseGeocodeRequest>,
    ) -> Result<Response<EncryptedReverseGeocodeResponse>, Status> {
        self.handlers()
            .await
            .reverse_geocode
            .encrypted_reverse_geocode(request)
            .await
    }

    async fn encrypted_function_execution(
        &self,
        request: Request<EncryptedFunctionCall>,
    ) -> Result<Response<EncryptedFunctionResponse>, Status> {
        self.handlers()
            .await
            .stubs
            .encrypted_function_execution(request)
            .await
    }

    async fn encrypted_analyze_image(
        &self,
        request: Request<EncryptedAnalyzeImageRequest>,
    ) -> Result<Response<EncryptedAnalyzeImageResponse>, Status> {
        self.handlers()
            .await
            .vision
            .encrypted_analyze_image(request)
            .await
    }

    async fn encrypted_analyze_food_image(
        &self,
        request: Request<EncryptedAnalyzeFoodImageRequest>,
    ) -> Result<Response<EncryptedAnalyzeFoodImageResponse>, Status> {
        self.handlers()
            .await
            .food
            .encrypted_analyze_food_image(request)
            .await
    }

    async fn encrypted_get_food_item(
        &self,
        request: Request<EncryptedGetFoodItemRequest>,
    ) -> Result<Response<EncryptedGetFoodItemResponse>, Status> {
        self.handlers()
            .await
            .food
            .encrypted_get_food_item(request)
            .await
    }

    async fn encrypted_action_based_interstitial(
        &self,
        request: Request<EncryptedActionBasedInterstitialRequest>,
    ) -> Result<Response<EncryptedActionBasedInterstitialResponse>, Status> {
        self.handlers()
            .await
            .action_interstitial
            .encrypted_action_based_interstitial(request)
            .await
    }

    async fn action_execution_test(
        &self,
        request: Request<ActionExecutionTestRequest>,
    ) -> Result<Response<ActionExecutionTestResponse>, Status> {
        self.handlers()
            .await
            .stubs
            .action_execution_test(request)
            .await
    }

    async fn transcription_repair_test(
        &self,
        request: Request<TranscriptionRepairTestRequest>,
    ) -> Result<Response<TranscriptionRepairTestResponse>, Status> {
        self.handlers()
            .await
            .stubs
            .transcription_repair_test(request)
            .await
    }

    async fn translate(
        &self,
        request: Request<EncryptedTranslateRequest>,
    ) -> Result<Response<EncryptedTranslateResponse>, Status> {
        self.handlers().await.stubs.translate(request).await
    }
}

/// External clients consumed by AIBus handlers.
///
/// Keeping these together makes provider injection explicit as the handler set
/// grows, while [`Self::disabled`] supplies fail-closed defaults for legacy
/// constructors and tests.
#[derive(Clone)]
pub struct AiBusExternalClients {
    google_maps: GoogleMapsClient,
    open_food_facts: OpenFoodFactsClient,
    spotify: Option<SpotifyService>,
    food_runtime_gate: FoodRuntimeGate,
}

impl AiBusExternalClients {
    pub fn new(
        google_maps: GoogleMapsClient,
        open_food_facts: OpenFoodFactsClient,
        spotify: Option<SpotifyService>,
    ) -> Self {
        Self {
            google_maps,
            open_food_facts,
            spotify,
            food_runtime_gate: FoodRuntimeGate::default(),
        }
    }

    pub(crate) fn with_food_runtime_gate(mut self, gate: FoodRuntimeGate) -> Self {
        self.food_runtime_gate = gate;
        self
    }

    #[cfg(test)]
    pub fn disabled(http_client: reqwest::Client) -> Self {
        Self::new(
            GoogleMapsClient::disabled(http_client.clone()),
            OpenFoodFactsClient::disabled(http_client),
            None,
        )
    }
}

pub struct AiBusHanders {
    action_interstitial: ActionInterstitialHandler,
    loading_message: LoadingMessageHandler,
    understand: Arc<UnderstandHandler>,
    vision: VisionHandler,
    weather: WeatherHandler,
    nearby: NearbySearchHandler,
    reverse_geocode: ReverseGeocodeHandler,
    completion: CompletionHandler,
    geolocate: GeoLocateHandler,
    navigation: NavigationDirectionsHandler,
    food: FoodHandler,
    smart_playlist: SmartPlaylistHandler,
    stubs: StubHandler,
}

impl AiBusHanders {
    /// Construct handlers with all externally configured clients. This is the
    /// production injection point; callers must explicitly enable each client
    /// and satisfy its independent compliance gates.
    // Dependency-injection constructor: each argument is a distinct collaborator,
    // not a cohesive group worth bundling into a struct.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_external_clients(
        agent: Arc<LlmAgent>,
        config: Arc<ResolvedConfig>,
        live_config: Arc<RwLock<Config>>,
        nearby_client: NearbyClient,
        http_client: reqwest::Client,
        db: Database,
        memory: Option<MemoryService>,
        external_clients: AiBusExternalClients,
    ) -> Self {
        let live_image_store = LiveImageStore::new();
        let AiBusExternalClients {
            google_maps,
            open_food_facts,
            spotify,
            food_runtime_gate,
        } = external_clients;
        let vision_automation =
            crate::synapse::capabilities::vision_automation::VisionAutomationStore::default();
        let agentic_external = AgenticExternalClients::new(
            google_maps.clone(),
            open_food_facts.clone(),
            spotify.clone(),
            build_web_search(&http_client, &config),
        );
        let food = FoodHandler::new(open_food_facts)
            .with_runtime_gate(food_runtime_gate.clone())
            .with_visual_model(agent.clone(), config.clone());

        Self {
            action_interstitial: ActionInterstitialHandler::new(),
            loading_message: LoadingMessageHandler::new(),
            understand: Arc::new(
                UnderstandHandler::new(
                    agent.clone(),
                    config.clone(),
                    live_config.clone(),
                    db.clone(),
                    memory.clone(),
                    live_image_store.clone(),
                    http_client.clone(),
                    nearby_client.clone(),
                )
                .with_vision_automation(vision_automation.clone())
                .with_food_handler(food.clone())
                .with_agentic_external_clients(agentic_external)
                // Loaded once per process; empty without the `local-nlu`
                // build or when the stock models are unavailable.
                .with_nlu_assists(crate::nlu::NluAssists::load()),
            ),
            vision: VisionHandler::new(live_image_store)
                .with_automation_store(vision_automation)
                .with_visual_model(agent.clone(), config.clone())
                .with_live_config(live_config)
                .with_food_handler(food.clone()),
            weather: WeatherHandler::new(
                http_client.clone(),
                config.pirate_weather_api_key.clone(),
                config.config.weather.temperature_unit,
            ),
            nearby: NearbySearchHandler::new(nearby_client),
            reverse_geocode: ReverseGeocodeHandler::new(
                http_client.clone(),
                config.openstreetmap_options.clone(),
            ),
            completion: CompletionHandler::new(agent.clone(), config.clone(), memory)
                .with_food_runtime_gate(food_runtime_gate),
            geolocate: GeoLocateHandler::new(google_maps.clone()),
            navigation: NavigationDirectionsHandler::new(google_maps),
            food,
            smart_playlist: SmartPlaylistHandler::new(spotify),
            stubs: StubHandler,
        }
    }

    pub fn with_function_execution(mut self, handler: FunctionExecutionHandler) -> Self {
        // The handler is Arc-shared so the chat-turn task can own it across
        // the streamed response. Reconfiguration happens during construction,
        // strictly before the Arc is shared with any request.
        Arc::get_mut(&mut self.understand)
            .expect("function execution is wired during construction, before sharing")
            .set_function_execution(handler);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_client_defaults_are_fail_closed() {
        let clients = AiBusExternalClients::disabled(reqwest::Client::new());

        assert!(!clients.google_maps.options().geolocation_enabled());
        assert!(!clients.google_maps.options().routes_enabled());
        assert!(!clients.open_food_facts.options().enabled());
        assert!(!clients.open_food_facts.options().attribution_acknowledged());
        assert!(clients.spotify.is_none());
    }
}

/// Assemble the wearer's web search from whatever this deployment configured.
///
/// Order is the policy's preference order and is measured, not guessed:
/// Brave first (0.7–1.0s) and SearXNG second (~1.1s) as the unmetered pair that
/// hedge for each other, with SerpAPI (3.3s, 100 searches/month) held back as
/// the metered last resort. An unconfigured provider is simply absent, so a Pin
/// with only one of them still works and one with none advertises no search
/// tool at all.
fn build_web_search(
    http_client: &reqwest::Client,
    config: &crate::config::ResolvedConfig,
) -> crate::external::web_search::WebSearch {
    use crate::external::web_search::WebSearchProvider;
    use std::sync::Arc;

    let mut providers: Vec<Arc<dyn WebSearchProvider>> = Vec::new();

    let brave = crate::external::brave_search::BraveSearchClient::new(
        http_client.clone(),
        config.brave_search_api_key.clone(),
    );
    if brave.is_configured() {
        providers.push(Arc::new(brave));
    }

    let searxng = crate::external::searxng::SearxngClient::new(
        http_client.clone(),
        config.searxng_base_url.clone(),
    );
    if searxng.is_configured() {
        providers.push(Arc::new(searxng));
    }

    let serpapi = crate::external::serpapi::SerpApiClient::new(
        http_client.clone(),
        config.serpapi_api_key.clone(),
    );
    // Appended like any other provider: `WebSearch` reads `is_metered()` and
    // holds it back as the last resort itself.
    if serpapi.is_configured() {
        providers.push(Arc::new(serpapi));
    }

    let search =
        crate::external::web_search::WebSearch::new(providers, config.web_search_geo.clone());
    tracing::info!(
        providers = ?search.provider_names(),
        country = %config.web_search_geo.country,
        language = %config.web_search_geo.language,
        "web search configured"
    );
    search
}
