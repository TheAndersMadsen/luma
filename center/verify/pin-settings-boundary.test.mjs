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
const { changedSettingFields } = await import(
  `../src/app/settings/pin/_lib/settingsFormState.ts${QUERY}`
);

const RESPONSE = {
  restart_required: false,
  server: {
    admin_token_auth: true,
    display_name: "My Pin",
    lan_dashboard_enabled: false,
  },
  contacts: {
    trust_all_contacts: false,
    allow_all_inbound: false,
  },
  dev: { apk_install_enabled: false },
  // Older Pin releases may still return these. Center must not treat them as
  // writable authority now that providers live in Cosmos.
  llm: { provider: "openai", has_api_key: true },
  google_maps: { has_api_key: true },
  azure_speech: { has_subscription_key: true },
};

test("normalizes only Pin-local settings", () => {
  const result = normalizeSettingsResponse(RESPONSE);

  assert.deepEqual(result.capabilities, {
    adminTokenAuth: true,
    lanDashboard: true,
  });
  assert.deepEqual(result.settings, {
    restart_required: false,
    server: {
      admin_token_auth: true,
      display_name: "My Pin",
      lan_dashboard_enabled: false,
    },
    contacts: {
      trust_all_contacts: false,
      allow_all_inbound: false,
    },
    dev: { apk_install_enabled: false },
  });
  assert.equal("llm" in result.settings, false);
  assert.equal("google_maps" in result.settings, false);
  assert.equal("azure_speech" in result.settings, false);
});

test("older responses default optional local capabilities off", () => {
  const result = normalizeSettingsResponse({ server: {} });
  assert.deepEqual(result.capabilities, NO_OPTIONAL_SETTINGS_CAPABILITIES);
  assert.deepEqual(result.settings.server, {
    admin_token_auth: false,
    display_name: undefined,
    lan_dashboard_enabled: undefined,
  });
});

test("malformed local settings fail at the boundary while retired provider data is ignored", () => {
  assert.throws(
    () => normalizeSettingsResponse({ server: { lan_dashboard_enabled: "yes" } }),
    /settings\.server\.lan_dashboard_enabled must be a boolean/,
  );
  assert.doesNotThrow(() =>
    normalizeSettingsResponse({ server: {}, llm: null, google_maps: "retired" }),
  );
});

test("save filtering permits only Pin-local fields", () => {
  const request = {
    llm: { model: "must-not-reach-the-pin", api_key: "secret" },
    server: {
      display_name: "Kitchen Pin",
      system_prompt: "must-live-in-cosmos",
      admin_token: "a".repeat(32),
      lan_dashboard_enabled: true,
    },
    weather: { pirate_weather_api_key: "secret" },
    google_maps: { api_key: "secret" },
    azure_speech: { subscription_key: "secret" },
    contacts: { trust_all_contacts: true, allow_all_inbound: false },
    dev: { apk_install_enabled: true, injected_package_recovery_enabled: true },
  };

  assert.deepEqual(
    filterSettingsRequestByCapabilities(request, {
      adminTokenAuth: true,
      lanDashboard: true,
    }),
    {
      server: {
        display_name: "Kitchen Pin",
        admin_token: "a".repeat(32),
        lan_dashboard_enabled: true,
      },
      contacts: { trust_all_contacts: true, allow_all_inbound: false },
      dev: { apk_install_enabled: true },
    },
  );
});

test("unadvertised local capabilities cannot be written", () => {
  assert.deepEqual(
    filterSettingsRequestByCapabilities(
      {
        server: {
          display_name: "Kept",
          admin_token: "a".repeat(32),
          lan_dashboard_enabled: true,
        },
      },
      NO_OPTIONAL_SETTINGS_CAPABILITIES,
    ),
    { server: { display_name: "Kept" } },
  );
});

test("write-only credential fields request a new password", async () => {
  const field = await readFile(
    new URL("../src/app/settings/pin/_lib/SecretField.tsx", import.meta.url),
    "utf8",
  );
  assert.match(field, /type="password"/u);
  assert.match(field, /autoComplete="new-password"/u);
});

test("save logging keeps field names but no values", () => {
  const fields = changedSettingFields({
    server: { admin_token: "private-token", display_name: "Private name" },
    contacts: { trust_all_contacts: true },
  });
  assert.deepEqual(fields, [
    "contacts.trust_all_contacts",
    "server.admin_token",
    "server.display_name",
  ]);
  assert.doesNotMatch(JSON.stringify(fields), /private-token|Private name/);
});
