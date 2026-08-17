export interface MemoryRecord {
  uuid: string;
  memory_type: "photo" | "video" | "food_log" | "note";
  device_local_id: string;
  created_at: string;
  status: "pending" | "uploading" | "complete" | "failed";
  files: string[];
  thumbnail_count: number;
  location?: Location;
}

export interface Location {
  latitude: number;
  longitude: number;
  accuracy?: number;
  human_readable?: string;
  full_address?: string;
}

export type ActivityKind = "notes" | "prompts" | "music";

export interface ActivityNote {
  id: string;
  created_at: string;
  text: string;
  location?: Location | null;
}

export interface ActivityPrompt {
  id: number;
  run_id: string;
  prompt: string;
  response?: string | null;
  is_vision: boolean;
  created_at: string;
}

export interface ConversationSummary {
  id: number;
  run_id: string;
  created_at: string;
  utterance: string;
  is_vision: boolean;
}

export interface ConversationMessage {
  role: string;
  content: string;
  seq: number;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ConversationMessage[];
}

export interface PaginatedConversations {
  conversations: ConversationSummary[];
  has_more: boolean;
}

export interface ActivityMusic {
  id: number;
  track_id: string;
  title: string;
  artists: string[];
  album?: string | null;
  status: string;
  started_at: string;
  ended_at?: string | null;
}

export interface ActivityItemByKind {
  notes: ActivityNote;
  prompts: ActivityPrompt;
  music: ActivityMusic;
}

export interface ActivityPage<K extends ActivityKind = ActivityKind> {
  items: ActivityItemByKind[K][];
  next_before?: string;
}

export type FitnessSessionFilename =
  | "activity-tracking-summary.csv"
  | "activity-tracking-location-data.gpx"
  | "activity-tracking-sensor-data.csv";

export interface FitnessSessionFile {
  filename: FitnessSessionFilename;
  size_bytes: number;
}

export interface FitnessSessionSummary {
  splits: string;
  pace: string;
  elapsed_time: string;
  cumulative_distance_km: number;
  moving_time: string;
  motion_breakdown: string;
  step_count: number;
}

export interface FitnessSession {
  session_id: string;
  started_at_ms: number;
  stopped_at_ms: number;
  duration_ms: number;
  files: FitnessSessionFile[];
  summary?: FitnessSessionSummary;
}

export interface FitnessSessionsResponse {
  sessions: FitnessSession[];
}

export interface HealthInfo {
  status: string;
  /** Display name. */
  name?: string;
  /** Server software version. */
  version?: string;
}

export interface ContactName {
  first_name?: string;
  last_name?: string;
  nickname?: string;
  display_name?: string;
}

export interface ContactEmail {
  value: string;
  type?: string;
}

export interface ContactPhoneNumber {
  value: string;
  type?: string;
}

export interface ContactRecord {
  id?: string;
  name?: ContactName;
  emails?: ContactEmail[];
  phone_numbers?: ContactPhoneNumber[];
  trusted?: boolean;
  emergency?: boolean;
  internal_favorite?: boolean;
  temporary?: boolean;
  contact_source?: string;
  organization?: string;
  modified_at?: number;
}

export interface ContactClientResetResponse {
  queued: boolean;
  receivers: number;
  message?: string;
}

export interface ComponentVersionInfo {
  role: string;
  label: string;
  package_name: string;
  version_name: string | null;
}

export interface OsVersionInfo {
  humane_display_version: string | null;
  android_release: string | null;
  android_sdk: string | null;
  security_patch: string | null;
}

export interface DeviceVersionSnapshot {
  components: ComponentVersionInfo[];
  os: OsVersionInfo;
}

export interface DeviceInfo {
  display_name: string;
  server_port?: number;
  http_bind_addr?: string;
  grpc_bind_addr?: string;
  llm_provider: string;
  llm_model: string;
  versions?: DeviceVersionSnapshot;
}

export interface Settings {
  /** True while persisted listener settings differ from the running process. */
  restart_required?: boolean;
  llm: {
    provider: string;
    model: string;
    has_api_key: boolean;
    base_url?: string;
    gemini_google_search?: boolean;
    /** URL of the optional host-side Codex App Server bridge. */
    codex_bridge_url?: string;
    /** The bridge credential is write-only; only its presence is returned. */
    has_codex_bridge_token?: boolean;
    /** Whether a private HTTPS CA certificate is configured for the bridge. */
    has_codex_bridge_ca?: boolean;
    /** Base URL for OpenAI-compatible model provider (e.g., DashScope). */
    codex_provider_base_url?: string;
    /** Model name for the OpenAI-compatible provider. */
    codex_model?: string;
    /** Whether an API key is configured for the OpenAI-compatible provider. */
    has_codex_api_key?: boolean;
    /** Provider name (Codex model_provider id), e.g. "dashscope". */
    codex_provider_name?: string;
    /** Wire API for the Codex provider ("responses" for Codex 0.144.x). */
    codex_wire_api?: string;
    /** Optional cue model for the custom provider (falls back to codex_model). */
    codex_cue_model?: string;
    /** Path to a Codex model-catalog JSON (parallel tools + real context metadata). */
    codex_model_catalog_path?: string;
    /** True when the custom provider is active (routes through Codex, not ChatGPT). */
    codex_custom_active?: boolean;
    /** Effective progress-cue model (provider-aware). */
    progress_cue_model?: string;
  };
  server: {
    /** Explicit wire capability; the secret itself is never returned. */
    admin_token_auth?: boolean;
    /** Present on older Kotlin-backed settings responses. */
    port?: number;
    /** Present on current Rust-backed settings responses. */
    http_bind_addr?: string;
    grpc_bind_addr?: string;
    public_addr?: string;
    system_prompt: string;
    status_prompt?: string;
    display_name?: string;
    /** Expose the authenticated dashboard API on Wi-Fi after restart. */
    lan_dashboard_enabled?: boolean;
  };
  storage: {
    media_dir: string;
    db_path: string;
  };
  weather: {
    has_api_key: boolean;
    /** Optional on legacy servers; Center normalizes absence to metric. */
    measurement_system?: MeasurementSystem;
    /** Optional on legacy servers; Center normalizes absence to Celsius. */
    temperature_unit?: TemperatureUnit;
  };
  /** Optional wire capability; absent on released legacy servers. */
  google_maps?: {
    /** The API key is write-only; only its resolved presence is returned. */
    has_api_key: boolean;
    geolocation_enabled: boolean;
    routes_enabled: boolean;
    routes_compliance_acknowledged: boolean;
    routes_travel_mode: GoogleMapsTravelMode;
    language_code: string;
  };
  /** Optional wire capability; absent on released legacy servers. */
  brave_search?: {
    /** The subscription key is write-only; only its resolved presence is returned. */
    has_api_key: boolean;
  };
  /** Optional wire capability; absent on released legacy servers. */
  open_food_facts?: {
    enabled: boolean;
    attribution_acknowledged: boolean;
    attribution: string;
    license_url: string;
  };
  /** Optional wire capability; absent on released legacy servers. */
  azure_speech?: {
    /** The subscription key is write-only; only its resolved presence is returned. */
    has_subscription_key: boolean;
    region?: string;
    voice_name?: string;
    enabled: boolean;
    cloud_consent_acknowledged: boolean;
  };
  /** Optional wire capability; absent on released legacy servers. */
  openstreetmap?: {
    enabled: boolean;
    location_consent_acknowledged: boolean;
  };
  contacts?: {
    trust_all_contacts?: boolean;
    allow_all_inbound?: boolean;
  };
  dev?: {
    apk_install_enabled?: boolean;
  };
}

/** Partial update request — only include fields you want to change. */
export interface UpdateSettingsRequest {
  llm?: {
    provider?: string;
    model?: string;
    api_key?: string;
    base_url?: string;
    gemini_google_search?: boolean;
    codex_bridge_url?: string;
    codex_bridge_token?: string;
    /** Optional PEM certificate used only to trust a private HTTPS bridge CA. */
    codex_bridge_ca_pem?: string;
    /** Base URL for OpenAI-compatible model provider (e.g., DashScope). */
    codex_provider_base_url?: string;
    /** Model name for the OpenAI-compatible provider. */
    codex_model?: string;
    /** API key for the OpenAI-compatible provider (write-only). */
    codex_api_key?: string;
    /** Provider name (Codex model_provider id), e.g. "dashscope". */
    codex_provider_name?: string;
    /** Wire API for the Codex provider ("responses" recommended). */
    codex_wire_api?: string;
    /** Optional cue model for the custom provider. */
    codex_cue_model?: string;
    /** Path to a Codex model-catalog JSON (parallel tools + real context metadata). */
    codex_model_catalog_path?: string;
    /** Progress-cue model (native or custom-provider model name). */
    progress_cue_model?: string;
  };
  server?: {
    system_prompt?: string;
    status_prompt?: string;
    display_name?: string;
    /** Write-only. Omission leaves the LAN/USB administration token unchanged. */
    admin_token?: string;
    /** Takes effect after the server process restarts. */
    lan_dashboard_enabled?: boolean;
  };
  weather?: {
    pirate_weather_api_key?: string;
    measurement_system?: MeasurementSystem;
    temperature_unit?: TemperatureUnit;
  };
  google_maps?: {
    /** Empty explicitly clears the persisted key; omission leaves it unchanged. */
    api_key?: string;
    geolocation_enabled?: boolean;
    routes_enabled?: boolean;
    routes_compliance_acknowledged?: boolean;
    routes_travel_mode?: GoogleMapsTravelMode;
    language_code?: string;
  };
  brave_search?: {
    /** Empty explicitly clears the persisted key; omission leaves it unchanged. */
    api_key?: string;
  };
  open_food_facts?: {
    enabled?: boolean;
    attribution_acknowledged?: boolean;
  };
  azure_speech?: {
    /** Empty explicitly clears the persisted key; omission leaves it unchanged. */
    subscription_key?: string;
    region?: string;
    voice_name?: string;
    enabled?: boolean;
    cloud_consent_acknowledged?: boolean;
  };
  openstreetmap?: {
    enabled?: boolean;
    location_consent_acknowledged?: boolean;
  };
  contacts?: {
    trust_all_contacts?: boolean;
    allow_all_inbound?: boolean;
  };
  dev?: {
    apk_install_enabled?: boolean;
  };
}

export type GoogleMapsTravelMode =
  | "walk"
  | "drive"
  | "bicycle"
  | "two-wheeler";

export type MeasurementSystem = "metric" | "imperial";
export type TemperatureUnit = "celsius" | "fahrenheit";

export type CodexStatusState =
  | "not_configured"
  | "unreachable"
  | "unauthorized"
  | "unavailable"
  | "signed_out"
  | "ready";

export interface CodexStatusResponse {
  state: CodexStatusState;
  ready: boolean;
  login_pending?: boolean;
  login_mode?: "chatgpt" | "api_key" | "other" | null;
}

export interface CodexDeviceCodeLoginResponse {
  verification_url: string;
  user_code: string;
}

export type SpotifyStatusState =
  | "disabled"
  | "not_configured"
  | "pairing"
  | "ready"
  | "error";

/** Safe, credential-free Spotify runtime status returned by the Pin. */
export interface SpotifyStatusResponse {
  enabled: boolean;
  experimental_acknowledged: boolean;
  state: SpotifyStatusState;
  device_name: string;
  username?: string;
  engine_ready: boolean;
  pairing_expires_at?: string;
  last_error?: string;
}

/** Spotify pairing settings. Passwords, client secrets, and tokens are never accepted. */
export interface SpotifySettingsRequest {
  enabled: boolean;
  experimental_acknowledged: boolean;
  device_name: string;
}

export type SpotifySearchKind = "track";

export interface SpotifySearchTrack {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  duration_ms?: number;
  explicit?: boolean;
}

export interface SpotifySearchResponse {
  items: SpotifySearchTrack[];
}

export type FeatureFlagValue =
  | { type: "bool"; value: boolean }
  | { type: "int"; value: number }
  | { type: "float"; value: number }
  | { type: "string"; value: string };

export type FeatureFlagSource =
  | "override"
  | "penumbra_default"
  | "firmware_default";

export interface FeatureFlagDefinition {
  key: string;
  label: string;
  description: string;
  value_type: FeatureFlagValue["type"];
  firmware_default: FeatureFlagValue;
  penumbra_default?: FeatureFlagValue | null;
  override_value?: FeatureFlagValue | null;
  /** Resolved value after applying override/default precedence for display. */
  desired_value: FeatureFlagValue;
  /**
   * Value present in Penumbra's replacement gRPC assignment set. A null value
   * means the key is omitted so stock arcOS resolves its firmware default.
   */
  assignment_value: FeatureFlagValue | null;
  source: FeatureFlagSource;
  writable: boolean;
  warning?: string | null;
  restart_recommended: boolean;
}

export interface FeatureFlagDelivery {
  /** Strongest delivery milestone the server has directly observed. */
  state:
    | "persisted"
    | "sync_dispatched"
    | "grpc_fetched"
    | "stock_cache_applied";
  /** SHA-256 identity of the complete server-managed assignment set. */
  desired_assignment_hash: string;
  /** True only when FeatureFlags.GetFlags fetched the matching assignment hash. */
  grpc_fetch_observed: boolean;
  /** Unix timestamp for the matching GetFlags fetch, when one has been observed. */
  last_grpc_fetch_unix_ms?: number | null;
  /** Unix timestamp for exact stock-cache application, when verified. */
  last_stock_cache_apply_unix_ms?: number | null;
  /** True only when exact hash/count application to the stock cache was verified. */
  stock_cache_verified: boolean;
  immediate_sync_supported: boolean;
  automatic_triggers: string[];
  note: string;
}

export interface SettingsGlobalFeatureGate {
  key: string;
  label: string;
  default: boolean;
  restart_recommended: boolean;
  /** False when the backend exposes this gate for status/recovery only. */
  writable: boolean;
  warning?: string | null;
  stored_value?: boolean | null;
  current_value?: boolean | null;
  source: "stored" | "default" | "unavailable";
  available: boolean;
  error?: string | null;
}

export interface FeatureFlagsResponse {
  flags: FeatureFlagDefinition[];
  settings_global_gates: SettingsGlobalFeatureGate[];
  settings_global_note: string;
  delivery: FeatureFlagDelivery;
  /** Present after an update; command accepted does not mean sync completed. */
  sync_requested?: boolean;
}

export interface UpdateFeatureFlagsRequest {
  /** A typed value sets an override; null restores the managed default. */
  overrides?: Record<string, FeatureFlagValue | null>;
  /** Separate Settings.Global patch; bool stores 0/1, null deletes the key. */
  settings_global?: Record<string, boolean | null>;
}

export type CellularServiceStatus =
  | "working"
  | "off"
  | "error"
  | "no_service"
  | "limited"
  | string;

export type CellularServiceReason =
  | "validated"
  | "mobile_data_disabled"
  | "radio_off"
  | "network_denied"
  | "emergency_only"
  | "out_of_service"
  | "connected_no_internet"
  | "no_data_connection"
  | "searching"
  | "telephony_unavailable"
  | "permission_missing"
  | string;

export type CellularServiceState =
  | "unknown"
  | "in_service"
  | "out_of_service"
  | "emergency_only"
  | "power_off"
  | string;

export type CellularDataConnectionState =
  | "unknown"
  | "disconnected"
  | "connecting"
  | "connected"
  | "suspended"
  | string;

export interface CellularServiceDetails {
  operator_name: string | null;
  network_type: string;
  service_state: CellularServiceState;
  signal_level: number | null;
  signal_dbm: number | null;
  mobile_data_enabled: boolean;
  data_connected: boolean;
  data_connection_state: CellularDataConnectionState;
  internet_validated: boolean;
  reject_cause?: number;
}

export interface CellularServicePayload {
  status: CellularServiceStatus;
  reason: CellularServiceReason;
  message: string;
  cellular_usable: boolean;
  details: CellularServiceDetails;
}

export interface CellularServiceStatusResponse {
  type:
    | "cellular.status_result"
    | "cellular.status_error"
    | "cellular.status_timeout"
    | string;
  request_id?: string | null;
  payload?:
    | CellularServicePayload
    | { message?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface SetEnabledRequest {
  enabled: boolean;
}

export interface DeviceTogglePayload {
  result?: "success" | string;
  enabled?: boolean;
  message?: string;
  [key: string]: unknown;
}

export interface DeviceToggleResponse {
  type:
    | "wifi.set_enabled_result"
    | "cellular.set_enabled_result"
    | "wifi.set_enabled_error"
    | "cellular.set_enabled_error"
    | "device.toggle_timeout"
    | "device.toggle_error"
    | string;
  request_id?: string | null;
  payload?: DeviceTogglePayload;
  [key: string]: unknown;
}

export type CellularSetEnabledResponse = DeviceToggleResponse;
export type WifiSetEnabledResponse = DeviceToggleResponse;

export interface EsimEvent {
  type: string;
  request_id?: string;
  action?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface EsimSnapshot {
  connected: boolean;
  requests: EsimRequestRecord[];
}

export interface EsimRequestRecord {
  request_id: string;
  action: string;
  status:
    | "pending"
    | "waiting_accept"
    | "accepted"
    | "running"
    | "completed"
    | "error"
    | string;
  accepted: boolean;
  events: EsimEvent[];
  final_event: EsimEvent | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface EsimProfile {
  name?: string;
  state?: string;
  iccid: string;
  service_provider?: string;
  nickname?: string;
  protected?: boolean;
  [key: string]: unknown;
}

export interface EsimProfilesResult {
  type?: string;
  result?: string;
  count?: number;
  profiles?: EsimProfile[];
  payload?: {
    result?: string;
    count?: number;
    profiles?: EsimProfile[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface EsimDeviceIdentifiersPayload {
  result?: string;
  eid?: string;
  imei?: string | null;
  raw_lastintent_result?: string;
  [key: string]: unknown;
}

export interface EsimEidResult {
  type?: "esim.device_identifiers_result" | string;
  result?: string;
  eid?: string;
  imei?: string | null;
  payload?: EsimDeviceIdentifiersPayload;
  [key: string]: unknown;
}

export interface EsimRequestAcceptedResponse {
  request_id: string;
}

export type EsimOperationStatus = "idle" | "pending" | "success" | "error";

export type StreamEvent =
  | { type: "memory_created"; memory: MemoryRecord }
  | { type: "memory_completed"; uuid: string }
  | { type: "memory_failed"; uuid: string }
  | { type: "memory_deleted"; uuid: string }
  | { type: "heartbeat" };
