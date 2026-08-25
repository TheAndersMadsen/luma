import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("global navigation remains the recovered Center navigation", async () => {
  const shell = await source("src/components/Shell.tsx");
  for (const destination of ["/", "/captures", "/notes", "/my-data", "/settings"]) {
    assert.match(shell, new RegExp(destination.replaceAll("/", "\\/")));
  }
  assert.doesNotMatch(shell, /href="\/(?:assistant|library|pin)(?:"|\/)/);
});

test("settings navigation exposes only current consumer destinations", async () => {
  const [nav, layout, registry, index] = await Promise.all([
    source("src/app/settings/SettingsNav.tsx"),
    source("src/app/settings/layout.tsx"),
    source("src/app/settings/settingsRegistry.ts"),
    source("src/app/settings/SettingsIndex.tsx"),
  ]);
  for (const destination of [
    "/settings/account/details",
    "/settings/account/devices",
    "/settings/account/features",
    "/settings/account/services",
    "/settings/contacts",
    "/settings/privacy",
    "/settings/pin/gallery",
    "/settings/pin/fitness",
    "/settings/pin/contacts",
    "/settings/pin/server",
    "/settings/pin/services",
    "/settings/pin/esim",
    "/settings/pin/flags",
    "/settings/pin/diagnostics",
    "/settings/about",
  ]) {
    const pattern = new RegExp(`"${destination.replaceAll("/", "\\/")}"`);
    assert.match(registry, pattern, `${destination} is missing from the settings registry`);
  }

  for (const destination of [
    "/settings/pin/setup",
    "/settings/pin",
    "/settings/pin/install",
  ]) {
    const pattern = new RegExp(`"${destination.replaceAll("/", "\\/")}"`);
    assert.match(registry, pattern, `${destination} should remain reachable from My Ai Pin`);
  }

  for (const destination of [
    "/settings/account/plan",
    "/settings/pin/conversations",
    "/settings/pin/activity",
  ]) {
    const pattern = new RegExp(`"${destination.replaceAll("/", "\\/")}"`);
    assert.doesNotMatch(registry, pattern, `${destination} should be removed from navigation`);
  }

  for (const group of [
    'ACCOUNT_GROUP = "Account"',
    'PIN_GROUP = "My Ai Pin"',
    'PIN_DEVICE_DATA_GROUP = "On this Pin"',
    'PIN_SETTINGS_GROUP = "Pin settings"',
    'PIN_ADVANCED_GROUP = "Advanced"',
  ]) assert.match(registry, new RegExp(group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.match(nav, /SETTINGS_GROUPS\.map/);
  assert.match(index, /SETTINGS_GROUPS\.map/);
  assert.match(index, /routeMatchesSearch/);
  assert.doesNotMatch(registry, /Added|additionTag|PIN_CONSOLE_GROUP/);
  assert.doesNotMatch(registry, /Plan & billing|Set up & recover|Conversations/);
  assert.doesNotMatch(nav, /SettingsRoutePicker/);
  assert.match(layout, /resolveSettingsPane\(pathname\)/);
  assert.doesNotMatch(nav, /href: "[^"]*terminal/);
});

test("the settings home explains the most useful areas without transport jargon", async () => {
  const [page, registry] = await Promise.all([
    source("src/app/settings/SettingsIndex.tsx"),
    source("src/app/settings/settingsRegistry.ts"),
  ]);
  for (const label of [
    "Account",
    "My Ai Pin",
    "On this Pin",
    "Pin settings",
    "Advanced",
  ]) assert.match(registry, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(page, /Search settings/);
  assert.match(page, /route\.description/);
  assert.doesNotMatch(`${page}\n${registry}`, /Iroh|ADB|transport|Added|Addition/);
  assert.doesNotMatch(`${page}\n${registry}`, /Set up & recover|plan information|conversations/i);
});

test("retired settings routes lead to a useful wearer page while Services stays real", async () => {
  const [orders, services, cosmosServices, about] = await Promise.all([
    source("src/app/settings/account/orders/page.tsx"),
    source("src/app/settings/account/services/page.tsx"),
    source("src/app/settings/account/services/CosmosServicesCard.tsx"),
    source("src/app/settings/about/page.tsx"),
  ]);

  assert.match(orders, /redirect\("\/settings\/account\/details"\)/);
  assert.match(services, /CosmosServicesCard/);
  assert.match(services, /SpotifyServiceCard/);
  assert.match(cosmosServices, /One provider authority/);
  assert.match(cosmosServices, /no search, maps, assistant or speech key is copied to the device/);
  assert.doesNotMatch(services, /redirect\(/);
  assert.doesNotMatch(about, /redirect\(/);
  assert.match(about, /centerRuntimeIdentity/);
  assert.doesNotMatch(about, /"unknown"/);
  assert.match(about, /dynamic\s*=\s*["']force-dynamic["']/);
  assert.match(about, /about-release/);
  assert.match(about, /about-environment/);
});

test("device page avoids unsupported placeholder rows", async () => {
  const devices = await source("src/app/settings/account/devices/page.tsx");

  assert.doesNotMatch(devices, />Device gifting<|>Transfer my number<|>Lost &amp; Found</);
  assert.match(devices, /PairPinRow/);
  assert.match(devices, /Wi-Fi QR code/);
  assert.match(devices, /Install or recover/);
  assert.match(devices, /href="\/settings\/pin\/install"/);
  assert.doesNotMatch(devices, /href="\/setup/);
  assert.match(devices, /device-status/);
});

test("every visible device-local pane tells the wearer which store it is", async () => {
  for (const pane of ["gallery", "contacts"]) {
    const text = await source(`src/app/settings/pin/${pane}/page.tsx`);
    assert.match(text, /CrossAuthorityNote/u, `${pane} does not name its data store`);
  }
});

test("removed settings surfaces stay absent and old history URLs lead to Ai Mic", async () => {
  const [details, conversations, conversationDetail, activity] = await Promise.all([
    source("src/app/settings/account/details/DetailsView.tsx"),
    source("src/app/settings/pin/conversations/page.tsx"),
    source("src/app/settings/pin/conversations/[id]/page.tsx"),
    source("src/app/settings/pin/activity/page.tsx"),
  ]);

  assert.doesNotMatch(details, /Legal|Terms of use|Privacy policy|Copyright notices/);
  for (const retired of [conversations, conversationDetail, activity]) {
    assert.match(retired, /redirect\("\/my-data\/ai-mic"\)/);
    assert.doesNotMatch(retired, /Refresh|On this Pin|Conversations on this Pin/);
  }
});

test("wearer feature page filters out technical and non-working records", async () => {
  const features = await source("src/app/settings/account/features/page.tsx");

  assert.match(features, /flag\.writable/);
  assert.match(features, /flag\.evidence !== "unknown"/);
  assert.match(features, /flag\.delivery === "next_sync"/);
  assert.doesNotMatch(features, /Show compatibility-only records|working controls|Search flags and behavior/);
  assert.doesNotMatch(features, /label=\{flag\.evidence\}|\{flag\.name\}<\/code>|deliveryText\(flag\.delivery\)/);
});
