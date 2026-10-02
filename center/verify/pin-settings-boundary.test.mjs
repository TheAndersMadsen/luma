
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

test("malformed local settings fail at the boundary while everything else is ignored", () => {
  assert.throws(
    () => normalizeSettingsResponse({ server: { lan_dashboard_enabled: "yes" } }),
    /settings\.server\.lan_dashboard_enabled must be a boolean/,
  );
  assert.throws(
    () => normalizeSettingsResponse({ server: {}, dev: { apk_install_enabled: "yes" } }),
    /settings\.dev\.apk_install_enabled must be a boolean/,
  );
  assert.doesNotThrow(() =>
    normalizeSettingsResponse({
      server: {},
      llm: null,
      open_food_facts: { enabled: "yes" },
      contacts: "retired",
      google_maps: "retired",
    }),
  );
});

test("save filtering permits only the fields a Pin pane edits", () => {
  const request = {
    llm: {
      model: "must-not-reach-the-pin",
      api_key: "secret",
      vision_consent_acknowledged: true,
    },
    server: {
      display_name: "Kitchen Pin",
      system_prompt: "must-live-in-cosmos",
      admin_token: "a".repeat(32),
      lan_dashboard_enabled: true,
    },
    weather: { pirate_weather_api_key: "secret" },
    google_maps: { api_key: "secret" },
    azure_speech: { subscription_key: "secret" },
    open_food_facts: { enabled: true, attribution_acknowledged: true },
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
    dev: { apk_install_enabled: true },
  });
  assert.deepEqual(fields, [
    "dev.apk_install_enabled",
    "server.admin_token",
    "server.display_name",
  ]);
  assert.doesNotMatch(JSON.stringify(fields), /private-token|Private name/);
});
