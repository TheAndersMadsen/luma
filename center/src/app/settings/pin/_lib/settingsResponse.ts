/*
 * Ported from the retired Setup SPA's `settingsResponse.ts` — only the type
 * import moved (`../api` -> `@/lib/pin-device`).
 *
 * Two jobs, and both are load-bearing for every "set up envs" pane:
 *
 *  1. Validate the settings boundary. A malformed section throws
 *     InvalidSettingsResponseError rather than silently producing a form whose
 *     save would overwrite good device config with undefined.
 *  2. Report CAPABILITIES. The Pin advertises what it understands by which keys
 *     it serialises, and `filterSettingsRequestByCapabilities` strips leaves an
 *     older server would ignore. Without that filter a pane can report "Saved"
 *     while the device silently dropped a secret it never knew about.
 */

import type {
  GoogleMapsTravelMode,
  MeasurementSystem,
  Settings,
  TemperatureUnit,
  UpdateSettingsRequest,
} from "@/lib/pin-device";

type GoogleMapsSettings = NonNullable<Settings["google_maps"]>;
type BraveSearchSettings = NonNullable<Settings["brave_search"]>;
type OpenFoodFactsSettings = NonNullable<Settings["open_food_facts"]>;
type AzureSpeechSettings = NonNullable<Settings["azure_speech"]>;
type OpenStreetMapSettings = NonNullable<Settings["openstreetmap"]>;
type WeatherSettings = Settings["weather"] & {
  measurement_system: MeasurementSystem;
  temperature_unit: TemperatureUnit;
};

export type NormalizedSettings = Omit<
  Settings,
  | "weather"
  | "google_maps"
  | "brave_search"
  | "open_food_facts"
  | "azure_speech"
  | "openstreetmap"
> & {
  weather: WeatherSettings;
  google_maps: GoogleMapsSettings;
  brave_search: BraveSearchSettings;
  open_food_facts: OpenFoodFactsSettings;
  azure_speech: AzureSpeechSettings;
  openstreetmap: OpenStreetMapSettings;
};

export interface SettingsCapabilities {
  adminTokenAuth: boolean;
  codex: boolean;
  codexCustomCa: boolean;
  /** Server understands the codex custom-provider leaves (codex_provider_*,
   * codex_model, codex_cue_model, codex_model_catalog_path, codex_api_key). */
  codexCustomProvider: boolean;
  /** Server understands the explicit progress_cue_model leaf. */
  progressCueModel: boolean;
  lanDashboard: boolean;
  weatherUnits: boolean;
  googleMaps: boolean;
  braveSearch: boolean;
  openFoodFacts: boolean;
  azureSpeech: boolean;
  openStreetMap: boolean;
}

export const NO_OPTIONAL_SETTINGS_CAPABILITIES: SettingsCapabilities = {
  adminTokenAuth: false,
  codex: false,
  codexCustomCa: false,
  codexCustomProvider: false,
  progressCueModel: false,
  lanDashboard: false,
  weatherUnits: false,
  googleMaps: false,
  braveSearch: false,
  openFoodFacts: false,
  azureSpeech: false,
  openStreetMap: false,
};

export class InvalidSettingsResponseError extends Error {
  constructor(path: string, expected: string) {
    super(`Invalid settings response: ${path} must be ${expected}`);
    this.name = "InvalidSettingsResponseError";
  }
}

const GOOGLE_MAPS_TRAVEL_MODES: readonly GoogleMapsTravelMode[] = [
  "walk",
  "drive",
  "bicycle",
  "two-wheeler",
];

const SAFE_GOOGLE_MAPS_SETTINGS: GoogleMapsSettings = {
  has_api_key: false,
  geolocation_enabled: false,
  routes_enabled: false,
  routes_compliance_acknowledged: false,
  routes_travel_mode: "walk",
  language_code: "en-US",
};

const SAFE_BRAVE_SEARCH_SETTINGS: BraveSearchSettings = {
  has_api_key: false,
};

const SAFE_OPEN_FOOD_FACTS_SETTINGS: OpenFoodFactsSettings = {
  enabled: false,
  attribution_acknowledged: false,
  attribution: "",
  license_url: "",
};

const SAFE_AZURE_SPEECH_SETTINGS: AzureSpeechSettings = {
  has_subscription_key: false,
  enabled: false,
  cloud_consent_acknowledged: false,
};

const SAFE_OPENSTREETMAP_SETTINGS: OpenStreetMapSettings = {
  enabled: false,
  location_consent_acknowledged: false,
};

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidSettingsResponseError(path, "an object");
  }
  return value as Record<string, unknown>;
}

function optionalSection(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  return hasOwn(root, key)
    ? requiredRecord(root[key], `settings.${key}`)
    : null;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new InvalidSettingsResponseError(`${path}.${key}`, "a string");
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  if (!hasOwn(record, key) || record[key] === null) return undefined;
  return requiredString(record, key, path);
}

function requiredBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new InvalidSettingsResponseError(`${path}.${key}`, "a boolean");
  }
  return value;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  if (!hasOwn(record, key) || record[key] === null) return undefined;
  return requiredBoolean(record, key, path);
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  if (!hasOwn(record, key) || record[key] === null) return undefined;
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidSettingsResponseError(`${path}.${key}`, "a number");
  }
  return value;
}

function normalizeMeasurementSystem(
  value: unknown,
  present: boolean,
): MeasurementSystem {
  if (!present) return "metric";
  if (typeof value !== "string") {
    throw new InvalidSettingsResponseError(
      "settings.weather.measurement_system",
      "metric or imperial",
    );
  }
  const normalized = value.trim().toLowerCase();
  if (normalized !== "metric" && normalized !== "imperial") {
    throw new InvalidSettingsResponseError(
      "settings.weather.measurement_system",
      "metric or imperial",
    );
  }
  return normalized;
}

function normalizeTemperatureUnit(
  value: unknown,
  present: boolean,
): TemperatureUnit {
  if (!present) return "celsius";
  if (typeof value !== "string") {
    throw new InvalidSettingsResponseError(
      "settings.weather.temperature_unit",
      "celsius or fahrenheit",
    );
  }
  const normalized = value.trim().toLowerCase();
  if (normalized !== "celsius" && normalized !== "fahrenheit") {
    throw new InvalidSettingsResponseError(
      "settings.weather.temperature_unit",
      "celsius or fahrenheit",
    );
  }
  return normalized;
}

function normalizeGoogleMaps(
  section: Record<string, unknown> | null,
): GoogleMapsSettings {
  if (!section) return { ...SAFE_GOOGLE_MAPS_SETTINGS };

  const travelMode = requiredString(
    section,
    "routes_travel_mode",
    "settings.google_maps",
  );
  if (!GOOGLE_MAPS_TRAVEL_MODES.includes(travelMode as GoogleMapsTravelMode)) {
    throw new InvalidSettingsResponseError(
      "settings.google_maps.routes_travel_mode",
      "a supported travel mode",
    );
  }

  return {
    has_api_key: requiredBoolean(
      section,
      "has_api_key",
      "settings.google_maps",
    ),
    geolocation_enabled: requiredBoolean(
      section,
      "geolocation_enabled",
      "settings.google_maps",
    ),
    routes_enabled: requiredBoolean(
      section,
      "routes_enabled",
      "settings.google_maps",
    ),
    routes_compliance_acknowledged: requiredBoolean(
      section,
      "routes_compliance_acknowledged",
      "settings.google_maps",
    ),
    routes_travel_mode: travelMode as GoogleMapsTravelMode,
    language_code: requiredString(
      section,
      "language_code",
      "settings.google_maps",
    ),
  };
}

function normalizeBraveSearch(
  section: Record<string, unknown> | null,
): BraveSearchSettings {
  if (!section) return { ...SAFE_BRAVE_SEARCH_SETTINGS };
  return {
    has_api_key: requiredBoolean(
      section,
      "has_api_key",
      "settings.brave_search",
    ),
  };
}

function normalizeOpenFoodFacts(
  section: Record<string, unknown> | null,
): OpenFoodFactsSettings {
  if (!section) return { ...SAFE_OPEN_FOOD_FACTS_SETTINGS };
  return {
    enabled: requiredBoolean(
      section,
      "enabled",
      "settings.open_food_facts",
    ),
    attribution_acknowledged: requiredBoolean(
      section,
      "attribution_acknowledged",
      "settings.open_food_facts",
    ),
    attribution: requiredString(
      section,
      "attribution",
      "settings.open_food_facts",
    ),
    license_url: requiredString(
      section,
      "license_url",
      "settings.open_food_facts",
    ),
  };
}

function normalizeAzureSpeech(
  section: Record<string, unknown> | null,
): AzureSpeechSettings {
  if (!section) return { ...SAFE_AZURE_SPEECH_SETTINGS };
  return {
    has_subscription_key: requiredBoolean(
      section,
      "has_subscription_key",
      "settings.azure_speech",
    ),
    region: optionalString(section, "region", "settings.azure_speech"),
    voice_name: optionalString(section, "voice_name", "settings.azure_speech"),
    enabled: requiredBoolean(section, "enabled", "settings.azure_speech"),
    cloud_consent_acknowledged: requiredBoolean(
      section,
      "cloud_consent_acknowledged",
      "settings.azure_speech",
    ),
  };
}

function normalizeOpenStreetMap(
  section: Record<string, unknown> | null,
): OpenStreetMapSettings {
  if (!section) return { ...SAFE_OPENSTREETMAP_SETTINGS };
  return {
    enabled: requiredBoolean(section, "enabled", "settings.openstreetmap"),
    location_consent_acknowledged: requiredBoolean(
      section,
      "location_consent_acknowledged",
      "settings.openstreetmap",
    ),
  };
}

/** Validate the settings boundary and materialize safe-off view defaults. */
export function normalizeSettingsResponse(input: unknown): {
  settings: NormalizedSettings;
  capabilities: SettingsCapabilities;
} {
  const root = requiredRecord(input, "settings");
  const llm = requiredRecord(root.llm, "settings.llm");
  const server = requiredRecord(root.server, "settings.server");
  const storage = requiredRecord(root.storage, "settings.storage");
  const weather = requiredRecord(root.weather, "settings.weather");
  const contacts = hasOwn(root, "contacts")
    ? requiredRecord(root.contacts, "settings.contacts")
    : null;
  const dev = hasOwn(root, "dev")
    ? requiredRecord(root.dev, "settings.dev")
    : null;

  const googleMaps = optionalSection(root, "google_maps");
  const braveSearch = optionalSection(root, "brave_search");
  const openFoodFacts = optionalSection(root, "open_food_facts");
  const azureSpeech = optionalSection(root, "azure_speech");
  const openStreetMap = optionalSection(root, "openstreetmap");
  const hasMeasurementSystem = hasOwn(weather, "measurement_system");
  const hasTemperatureUnit = hasOwn(weather, "temperature_unit");
  const weatherUnits = hasMeasurementSystem && hasTemperatureUnit;

  const hasCodexBridgeUrl = hasOwn(llm, "codex_bridge_url");
  const hasCodexBridgeTokenPresence = hasOwn(llm, "has_codex_bridge_token");
  if (hasCodexBridgeUrl !== hasCodexBridgeTokenPresence) {
    throw new InvalidSettingsResponseError(
      "settings.llm Codex fields",
      "both present or both absent",
    );
  }
  const codex = hasCodexBridgeUrl;
  const codexCustomCa = hasOwn(llm, "has_codex_bridge_ca");
  // Newer servers always serialize these two, so their presence is the
  // capability signal for the custom-provider and cue-model write leaves.
  const codexCustomProvider = hasOwn(llm, "has_codex_api_key");
  const progressCueModel = hasOwn(llm, "progress_cue_model");
  const lanDashboard = hasOwn(server, "lan_dashboard_enabled");
  const adminTokenAuth =
    optionalBoolean(server, "admin_token_auth", "settings.server") === true;
  const provider = requiredString(llm, "provider", "settings.llm");
  if (provider === "codex" && !codex) {
    throw new InvalidSettingsResponseError(
      "settings.llm Codex fields",
      "present when the Codex provider is selected",
    );
  }

  const settings: NormalizedSettings = {
    restart_required: optionalBoolean(
      root,
      "restart_required",
      "settings",
    ),
    llm: {
      provider,
      model: requiredString(llm, "model", "settings.llm"),
      has_api_key: requiredBoolean(llm, "has_api_key", "settings.llm"),
      base_url: optionalString(llm, "base_url", "settings.llm"),
      gemini_google_search: optionalBoolean(
        llm,
        "gemini_google_search",
        "settings.llm",
      ),
      progress_cue_model: optionalString(
        llm,
        "progress_cue_model",
        "settings.llm",
      ),
      ...(codex
        ? {
            codex_bridge_url: requiredString(
              llm,
              "codex_bridge_url",
              "settings.llm",
            ),
            has_codex_bridge_token: requiredBoolean(
              llm,
              "has_codex_bridge_token",
              "settings.llm",
            ),
            has_codex_bridge_ca: optionalBoolean(
              llm,
              "has_codex_bridge_ca",
              "settings.llm",
            ),
            codex_provider_base_url: optionalString(
              llm,
              "codex_provider_base_url",
              "settings.llm",
            ),
            codex_model: optionalString(llm, "codex_model", "settings.llm"),
            codex_provider_name: optionalString(
              llm,
              "codex_provider_name",
              "settings.llm",
            ),
            codex_wire_api: optionalString(
              llm,
              "codex_wire_api",
              "settings.llm",
            ),
            codex_cue_model: optionalString(
              llm,
              "codex_cue_model",
              "settings.llm",
            ),
            codex_model_catalog_path: optionalString(
              llm,
              "codex_model_catalog_path",
              "settings.llm",
            ),
            has_codex_api_key: optionalBoolean(
              llm,
              "has_codex_api_key",
              "settings.llm",
            ),
            codex_custom_active: optionalBoolean(
              llm,
              "codex_custom_active",
              "settings.llm",
            ),
          }
        : {}),
    },
    server: {
      admin_token_auth: optionalBoolean(
        server,
        "admin_token_auth",
        "settings.server",
      ),
      port: optionalNumber(server, "port", "settings.server"),
      http_bind_addr: optionalString(
        server,
        "http_bind_addr",
        "settings.server",
      ),
      grpc_bind_addr: optionalString(
        server,
        "grpc_bind_addr",
        "settings.server",
      ),
      public_addr: optionalString(server, "public_addr", "settings.server"),
      system_prompt: requiredString(
        server,
        "system_prompt",
        "settings.server",
      ),
      status_prompt: optionalString(
        server,
        "status_prompt",
        "settings.server",
      ),
      display_name: optionalString(
        server,
        "display_name",
        "settings.server",
      ),
      lan_dashboard_enabled: optionalBoolean(
        server,
        "lan_dashboard_enabled",
        "settings.server",
      ),
    },
    storage: {
      media_dir: requiredString(storage, "media_dir", "settings.storage"),
      db_path: requiredString(storage, "db_path", "settings.storage"),
    },
    weather: {
      has_api_key: requiredBoolean(
        weather,
        "has_api_key",
        "settings.weather",
      ),
      measurement_system: normalizeMeasurementSystem(
        weather.measurement_system,
        hasMeasurementSystem,
      ),
      temperature_unit: normalizeTemperatureUnit(
        weather.temperature_unit,
        hasTemperatureUnit,
      ),
    },
    google_maps: normalizeGoogleMaps(googleMaps),
    brave_search: normalizeBraveSearch(braveSearch),
    open_food_facts: normalizeOpenFoodFacts(openFoodFacts),
    azure_speech: normalizeAzureSpeech(azureSpeech),
    openstreetmap: normalizeOpenStreetMap(openStreetMap),
    ...(contacts
      ? {
          contacts: {
            trust_all_contacts: optionalBoolean(
              contacts,
              "trust_all_contacts",
              "settings.contacts",
            ),
            allow_all_inbound: optionalBoolean(
              contacts,
              "allow_all_inbound",
              "settings.contacts",
            ),
          },
        }
      : {}),
    ...(dev
      ? {
          dev: {
            apk_install_enabled: optionalBoolean(
              dev,
              "apk_install_enabled",
              "settings.dev",
            ),
          },
        }
      : {}),
  };

  return {
    settings,
    capabilities: {
      adminTokenAuth,
      codex,
      codexCustomCa,
      codexCustomProvider,
      progressCueModel,
      lanDashboard,
      weatherUnits,
      googleMaps: googleMaps !== null,
      braveSearch: braveSearch !== null,
      openFoodFacts: openFoodFacts !== null,
      azureSpeech: azureSpeech !== null,
      openStreetMap: openStreetMap !== null,
    },
  };
}

/** Remove settings leaves or sections the response did not advertise. */
export function filterSettingsRequestByCapabilities(
  request: UpdateSettingsRequest,
  capabilities: SettingsCapabilities,
): UpdateSettingsRequest {
  const filtered: UpdateSettingsRequest = { ...request };

  if (request.llm) {
    const llm = { ...request.llm };
    if (!capabilities.codex) {
      delete llm.codex_bridge_url;
      delete llm.codex_bridge_token;
      if (llm.provider === "codex") delete llm.provider;
    }
    if (!capabilities.codexCustomCa) delete llm.codex_bridge_ca_pem;
    if (!capabilities.codexCustomProvider) {
      // A server that predates the custom-provider leaves would silently
      // ignore them (including the secret API key) while the UI reports a
      // successful save, so never send them to such a server.
      delete llm.codex_provider_base_url;
      delete llm.codex_model;
      delete llm.codex_provider_name;
      delete llm.codex_wire_api;
      delete llm.codex_cue_model;
      delete llm.codex_model_catalog_path;
      delete llm.codex_api_key;
    }
    if (!capabilities.progressCueModel) delete llm.progress_cue_model;
    if (Object.keys(llm).length > 0) filtered.llm = llm;
    else delete filtered.llm;
  }

  if (request.server) {
    const server = { ...request.server };
    if (!capabilities.adminTokenAuth) delete server.admin_token;
    if (!capabilities.lanDashboard) delete server.lan_dashboard_enabled;
    if (Object.keys(server).length > 0) filtered.server = server;
    else delete filtered.server;
  }

  if (request.weather) {
    const weather = { ...request.weather };
    if (!capabilities.weatherUnits) {
      delete weather.measurement_system;
      delete weather.temperature_unit;
    }
    if (Object.keys(weather).length > 0) filtered.weather = weather;
    else delete filtered.weather;
  }

  if (!capabilities.googleMaps) delete filtered.google_maps;
  if (!capabilities.braveSearch) delete filtered.brave_search;
  if (!capabilities.openFoodFacts) delete filtered.open_food_facts;
  if (!capabilities.azureSpeech) delete filtered.azure_speech;
  if (!capabilities.openStreetMap) delete filtered.openstreetmap;

  return filtered;
}
