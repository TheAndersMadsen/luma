/*
 * Behavioural guards for the two modules that sit on the settings SAVE path:
 * `_lib/settingsResponse` (what the Pin advertises, and what may be sent back)
 * and `_lib/settingsFormState` (how a credential is edited without ever being
 * read back).
 *
 * Both exist because of failures that are silent by construction:
 *
 *   - `filterSettingsRequestByCapabilities` strips leaves the connected Pin
 *     never advertised. An older Pin ignores keys it does not know, so without
 *     the filter a pane reports "Saved" while the device drops the secret it
 *     was handed. Capability detection is derived from which keys the response
 *     serialises, so the normalize cases below pin the exact released wire shape
 *     rather than a hand-written approximation of it — that is the only way the
 *     detection can be shown to still work against a real old Pin.
 *   - `normalizeSettingsResponse` THROWS on a malformed section instead of
 *     returning a partial object. A form built from `undefined` would save
 *     `undefined` over good device config, so the boundary has to fail loudly.
 *   - The Pin never returns a credential's value, only a `has_*` boolean, so
 *     every secret is edited as a SecretEdit. "unchanged" sends nothing, "set"
 *     sends the value, "clear" sends the empty string. A plain string field
 *     cannot distinguish "the user left it alone" from "the user wants it
 *     cleared", and one of those two is destructive.
 *   - `changedSettingFields` feeds the save log. It returns NAMES only, so the
 *     assertion that no value survives into its output is the thing standing
 *     between a save and a credential in a log line.
 *
 * Ported from the `pin/setup` SPA's vitest suite. Center's copies of both
 * modules differ from the SPA's only by header comments, an expanded doc
 * comment on `changedSettingFields`, and the `../api` -> `@/lib/pin-device`
 * type import; no behaviour moved.
 */

// Registers the resolve hook that lets these `src/` modules reach their own
// extensionless siblings and `@/lib/…` aliases under Node's type stripping.
// Static, so it is evaluated before the dynamic imports below.
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const QUERY = "?pin-settings-boundary-test";

const {
  NO_OPTIONAL_SETTINGS_CAPABILITIES,
  filterSettingsRequestByCapabilities,
  normalizeSettingsResponse,
} = await import(`../src/app/settings/pin/_lib/settingsResponse.ts${QUERY}`);
const {
  UNCHANGED_SECRET_EDIT,
  changedSettingFields,
  secretEditFromInput,
  secretEditInputValue,
  secretEditRequestValue,
} = await import(`../src/app/settings/pin/_lib/settingsFormState.ts${QUERY}`);

// Exact wire shape emitted by the released Rust SettingsResponse at 4e44d47.
// tools/memory are deliberately included even though this Center form does not
// edit them: capability detection keys off which sections the Pin serialises,
// so a trimmed fixture would stop testing the thing that matters.
const RELEASED_LEGACY_SETTINGS_RESPONSE = {
  llm: {
    provider: "echo",
    model: "gemini-2.5-flash",
    has_api_key: false,
    base_url: null,
    gemini_google_search: false,
    tools: {
      enabled: true,
      dynamic_tool_count: 8,
      max_tool_turns: 5,
      tool_concurrency: 2,
    },
    memory: {
      enabled: true,
      path: "./data/assistant-memory.mv2",
      top_k: 5,
      snippet_chars: 500,
      max_context_chars: 1500,
      auto_retrieve: true,
      auto_remember: false,
    },
  },
  server: {
    http_bind_addr: "0.0.0.0:8080",
    grpc_bind_addr: "127.0.0.1:9090",
    public_addr: "127.0.0.1:8080",
    system_prompt:
      "You are a helpful assistant running on a Humane AI Pin. Keep responses concise - they will be displayed on a laser projector and spoken aloud.",
    status_prompt: `Current request status:
- Current timestamp: {{current_timestamp}}
- Current date: {{current_date}}
- Current time: {{current_time}}
{{#if location_name}}- User location: {{location_name}}{{else}}- User location: unknown
{{/if}}{{#if coordinates}}- User coordinates: {{coordinates}}
{{/if}}
This status applies to the current user request only. If it conflicts with earlier conversation history, prefer this current status.`,
    display_name: null,
  },
  storage: {
    media_dir: "./media",
    db_path: "./data/penumbra.db",
  },
  weather: {
    has_api_key: false,
  },
  contacts: {
    trust_all_contacts: false,
    allow_all_inbound: false,
  },
  dev: {
    apk_install_enabled: false,
  },
};

/* ── normalizeSettingsResponse ────────────────────────────────────────────── */

test("normalizes the exact released response to hidden, safe-off capabilities", () => {
  const result = normalizeSettingsResponse(RELEASED_LEGACY_SETTINGS_RESPONSE);

  assert.deepEqual(result.capabilities, {
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
  });
  assert.equal(result.settings.llm.base_url, undefined);
  assert.equal(result.settings.server.display_name, undefined);
  assert.deepEqual(result.settings.google_maps, {
    has_api_key: false,
    geolocation_enabled: false,
    routes_enabled: false,
    routes_compliance_acknowledged: false,
    routes_travel_mode: "walk",
    language_code: "en-US",
  });
  assert.equal(result.settings.brave_search.has_api_key, false);
  assert.equal(result.settings.open_food_facts.enabled, false);
  assert.equal(result.settings.azure_speech.enabled, false);
  assert.equal(result.settings.openstreetmap.enabled, false);
  assert.equal(result.settings.weather.measurement_system, "metric");
  assert.equal(result.settings.weather.temperature_unit, "celsius");
});

test("tracks optional sections independently", () => {
  const result = normalizeSettingsResponse({
    ...RELEASED_LEGACY_SETTINGS_RESPONSE,
    restart_required: true,
    google_maps: {
      has_api_key: true,
      geolocation_enabled: false,
      routes_enabled: false,
      routes_compliance_acknowledged: false,
      routes_travel_mode: "bicycle",
      language_code: "da-DK",
    },
  });

  assert.deepEqual(result.capabilities, {
    adminTokenAuth: false,
    codex: false,
    codexCustomCa: false,
    codexCustomProvider: false,
    progressCueModel: false,
    lanDashboard: false,
    weatherUnits: false,
    googleMaps: true,
    braveSearch: false,
    openFoodFacts: false,
    azureSpeech: false,
    openStreetMap: false,
  });
  assert.equal(result.settings.restart_required, true);
  assert.equal(result.settings.google_maps.routes_travel_mode, "bicycle");
});

test("normalizes advertised weather units and marks them writable", () => {
  const result = normalizeSettingsResponse({
    ...RELEASED_LEGACY_SETTINGS_RESPONSE,
    weather: {
      has_api_key: true,
      measurement_system: "IMPERIAL",
      temperature_unit: "Fahrenheit",
    },
  });

  assert.equal(result.capabilities.weatherUnits, true);
  assert.equal(result.settings.weather.measurement_system, "imperial");
  assert.equal(result.settings.weather.temperature_unit, "fahrenheit");
});

test("uses the explicit admin-token auth capability in a modern bundle", () => {
  const result = normalizeSettingsResponse({
    ...RELEASED_LEGACY_SETTINGS_RESPONSE,
    restart_required: true,
    llm: {
      ...RELEASED_LEGACY_SETTINGS_RESPONSE.llm,
      codex_bridge_url: "http://127.0.0.1:8765",
      has_codex_bridge_token: false,
      has_codex_bridge_ca: false,
    },
    server: {
      ...RELEASED_LEGACY_SETTINGS_RESPONSE.server,
      admin_token_auth: true,
      lan_dashboard_enabled: true,
    },
    google_maps: {
      has_api_key: false,
      geolocation_enabled: false,
      routes_enabled: false,
      routes_compliance_acknowledged: false,
      routes_travel_mode: "walk",
      language_code: "en-US",
    },
    brave_search: {
      has_api_key: true,
    },
    open_food_facts: {
      enabled: false,
      attribution_acknowledged: false,
      attribution: "Open Food Facts",
      license_url: "https://example.test/license",
    },
    azure_speech: {
      has_subscription_key: false,
      enabled: false,
      cloud_consent_acknowledged: false,
    },
    openstreetmap: {
      enabled: false,
      location_consent_acknowledged: false,
    },
  });

  assert.equal(result.capabilities.adminTokenAuth, true);
  assert.equal(result.capabilities.codexCustomCa, true);
  assert.equal(result.capabilities.lanDashboard, true);
  assert.equal(result.capabilities.braveSearch, true);
  assert.equal(result.settings.brave_search.has_api_key, true);
  assert.equal(result.settings.restart_required, true);
  assert.equal(result.settings.server.lan_dashboard_enabled, true);
});

test("tracks admin-token auth independently of optional integrations", () => {
  const result = normalizeSettingsResponse({
    ...RELEASED_LEGACY_SETTINGS_RESPONSE,
    server: {
      ...RELEASED_LEGACY_SETTINGS_RESPONSE.server,
      admin_token_auth: true,
    },
  });

  assert.equal(result.capabilities.adminTokenAuth, true);
  assert.equal(result.capabilities.codex, false);
  assert.equal(result.capabilities.googleMaps, false);
});

test("rejects malformed restart metadata", () => {
  assert.throws(
    () =>
      normalizeSettingsResponse({
        ...RELEASED_LEGACY_SETTINGS_RESPONSE,
        restart_required: "yes",
      }),
    {
      message:
        "Invalid settings response: settings.restart_required must be a boolean",
    },
  );
});

test("rejects a malformed core response with a controlled boundary error", () => {
  assert.throws(
    () =>
      normalizeSettingsResponse({
        ...RELEASED_LEGACY_SETTINGS_RESPONSE,
        server: { system_prompt: null },
      }),
    {
      message:
        "Invalid settings response: settings.server.system_prompt must be a string",
    },
  );
});

/* ── filterSettingsRequestByCapabilities ──────────────────────────────────── */

test("never emits unadvertised sections, Codex fields, or the Codex provider", () => {
  const filtered = filterSettingsRequestByCapabilities(
    {
      llm: {
        provider: "codex",
        model: "gpt-5.4",
        codex_bridge_url: "http://127.0.0.1:8765",
        codex_bridge_token: "secret",
        codex_bridge_ca_pem: "certificate",
        codex_provider_base_url: "https://dashscope.example/v1",
        codex_model: "qwen3.7-max",
        codex_provider_name: "dashscope",
        codex_wire_api: "responses",
        codex_cue_model: "qwen-flash",
        codex_model_catalog_path: "/data/local/tmp/catalog.json",
        codex_api_key: "provider-secret",
        progress_cue_model: "gpt-5.4-mini",
      },
      server: {
        display_name: "Kept",
        admin_token: "a".repeat(32),
        lan_dashboard_enabled: true,
      },
      google_maps: { geolocation_enabled: true },
      brave_search: { api_key: "brave-secret" },
      open_food_facts: { enabled: true },
      azure_speech: { enabled: true },
      openstreetmap: { enabled: true },
    },
    NO_OPTIONAL_SETTINGS_CAPABILITIES,
  );

  assert.deepEqual(filtered, {
    llm: { model: "gpt-5.4" },
    server: { display_name: "Kept" },
  });
});

test("keeps custom-provider and cue leaves when the response advertises them", () => {
  const request = {
    llm: {
      codex_provider_base_url: "https://dashscope.example/v1",
      codex_api_key: "provider-secret",
      codex_model_catalog_path: "/data/local/tmp/catalog.json",
      progress_cue_model: "gpt-5.4-mini",
    },
  };

  assert.deepEqual(
    filterSettingsRequestByCapabilities(request, {
      ...NO_OPTIONAL_SETTINGS_CAPABILITIES,
      codexCustomProvider: true,
      progressCueModel: true,
    }),
    request,
  );
});

test("keeps unit updates only when the response advertises unit support", () => {
  const request = {
    weather: {
      pirate_weather_api_key: "weather-secret",
      measurement_system: "imperial",
      temperature_unit: "fahrenheit",
    },
  };

  assert.deepEqual(
    filterSettingsRequestByCapabilities(request, {
      ...NO_OPTIONAL_SETTINGS_CAPABILITIES,
      weatherUnits: false,
    }),
    { weather: { pirate_weather_api_key: "weather-secret" } },
  );
  assert.deepEqual(
    filterSettingsRequestByCapabilities(request, {
      ...NO_OPTIONAL_SETTINGS_CAPABILITIES,
      weatherUnits: true,
    }),
    request,
  );
});

/* ── secret setting edits ─────────────────────────────────────────────────── */

test("distinguishes unchanged, replacement, and explicit clearing", () => {
  assert.equal(secretEditRequestValue(UNCHANGED_SECRET_EDIT), undefined);
  assert.equal(
    secretEditRequestValue({ kind: "set", value: "new-token" }),
    "new-token",
  );
  assert.equal(secretEditRequestValue({ kind: "clear" }), "");
});

test("maps an empty editor back to unchanged without inventing a clear", () => {
  assert.deepEqual(secretEditFromInput(""), { kind: "unchanged" });
  assert.deepEqual(secretEditFromInput("new-token"), {
    kind: "set",
    value: "new-token",
  });
  assert.equal(secretEditInputValue({ kind: "clear" }), "");
});

test("write-only credential fields never invite an existing password autofill", async () => {
  const field = await readFile(
    new URL("../src/app/settings/pin/_lib/SecretField.tsx", import.meta.url),
    "utf8",
  );
  assert.match(field, /type="password"/u);
  assert.match(field, /autoComplete="new-password"/u);
  assert.doesNotMatch(field, /autoComplete="off"/u);
});

/* ── changedSettingFields ─────────────────────────────────────────────────── */

test("returns field names without retaining secret or prompt values", () => {
  const fields = changedSettingFields({
    llm: {
      codex_bridge_token: "private-pairing-token",
      model: "private-model-input",
    },
    server: {
      system_prompt: "private system prompt",
      status_prompt: "private status prompt",
    },
      google_maps: {
        api_key: "private-maps-key",
        routes_enabled: true,
      },
      brave_search: {
        api_key: "private-brave-key",
      },
    azure_speech: {
      subscription_key: "private-azure-key",
      enabled: true,
    },
  });

  assert.deepEqual(fields, [
    "azure_speech.enabled",
    "azure_speech.subscription_key",
    "brave_search.api_key",
    "google_maps.api_key",
    "google_maps.routes_enabled",
    "llm.codex_bridge_token",
    "llm.model",
    "server.status_prompt",
    "server.system_prompt",
  ]);
  assert.doesNotMatch(
    JSON.stringify(fields),
    /private-brave-key|private-maps-key|private-azure-key|private-pairing-token|private-model-input|private system prompt|private status prompt/,
  );
});

test("keeps Brave writes only when the response advertises the capability", () => {
  const request = { brave_search: { api_key: "brave-secret" } };

  assert.deepEqual(
    filterSettingsRequestByCapabilities(
      request,
      NO_OPTIONAL_SETTINGS_CAPABILITIES,
    ),
    {},
  );
  assert.deepEqual(
    filterSettingsRequestByCapabilities(request, {
      ...NO_OPTIONAL_SETTINGS_CAPABILITIES,
      braveSearch: true,
    }),
    request,
  );
});
