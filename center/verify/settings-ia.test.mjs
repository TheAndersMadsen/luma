import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Services configures and tests Cosmos providers without placing credentials on the Pin", async () => {
  const [page, card, route, codexRoute, testRoute, css] = await Promise.all([
    source("src/app/settings/account/services/page.tsx"),
    source("src/app/settings/account/services/CosmosServicesCard.tsx"),
    source("src/app/api/admin/integrations/route.ts"),
    source("src/app/api/admin/integrations/codex/route.ts"),
    source("src/app/api/admin/integrations/test/route.ts"),
    source("src/app/settings/account/services/services.module.css"),
  ]);

  assert.match(page, /currentSession/);
  assert.match(page, /operator=\{session\?\.operator === true\}/);
  for (const label of [
    "OpenAI-compatible API",
    "Codex subscription",
    "SearxNG URL",
    "Google Maps key",
    "Azure Speech key",
    "OS3 session cookie",
  ]) assert.match(card, new RegExp(label));
  assert.match(card, /type="password"/);
  assert.match(card, /api_key_configured/);
  assert.match(card, /Your accounts stay on your server/);
  for (const target of [
    "assistant",
    "searxng",
    "serpapi",
    "perplexity",
    "maps",
    "weather",
    "wolfram",
    "speech",
    "os3",
  ]) assert.match(card, new RegExp(`"${target}"`));
  assert.match(card, /Test/);
  assert.match(card, /Working/);
  assert.match(card, /Failed/);
  assert.doesNotMatch(card, /\/api\/pin\/|PENUMBRA_|OPENAI_API_KEY/);
  for (const sourceText of [route, codexRoute, testRoute]) {
    assert.match(sourceText, /requireOperatorRequest/);
    assert.match(sourceText, /adminAuthHeaders/);
    assert.match(sourceText, /cache-control.*private, no-store/s);
  }
  assert.match(route, /isSameOriginRequest/);
  assert.match(codexRoute, /isSameOriginRequest/);
  assert.match(testRoute, /isSameOriginRequest/);
  assert.match(testRoute, /demo-api\/admin\/integrations\/test/);
  assert.match(css, /\.pairingTimer\s*\{[^}]*place-items:\s*center/s);
  assert.match(
    css,
    /\.settingRow > span:not\(\[data-status-tone\]\),\s*\.fieldRow > span:not\(\[data-status-tone\]\)\s*\{[^}]*display:\s*grid/s,
  );
});

test("the old admin dashboard is one Settings provisioning pane without duplicate panels", async () => {
  const [admin, page, view, setup] = await Promise.all([
    source("src/app/admin/page.tsx"),
    source("src/app/settings/pin/provision/page.tsx"),
    source("src/app/settings/pin/provision/ProvisioningView.tsx"),
    source("src/app/settings/pin/setup/page.tsx"),
  ]);

  assert.match(admin, /requireOperatorSession\("\/admin"\)/);
  assert.match(admin, /redirect\(OPERATOR_PROVISIONING_PATH\)/);
  assert.match(page, /requireOperatorSession\(OPERATOR_PROVISIONING_PATH\)/);
  assert.match(view, /Create activation file/);
  assert.match(setup, /provisioningHref=\{operator \? "\/settings\/pin\/provision" : null\}/);
  assert.doesNotMatch(view, /api\/admin\/(?:flags|devices)|Feature flags|Persistence|Device roster/);

  for (const removed of [
    "src/app/admin/AdminFeatureFlags.tsx",
    "src/app/admin/AdminDataPanels.tsx",
    "src/app/api/admin/flags/route.ts",
    "src/app/api/admin/devices/route.ts",
  ]) await assert.rejects(access(new URL(removed, root)), undefined, `${removed} still exists`);
});

test("wiping every workout on the Pin takes two presses", async () => {
  const [shell, fitness] = await Promise.all([
    source("src/app/settings/pin/_lib/PaneShell.tsx"),
    source("src/app/settings/pin/fitness/page.tsx"),
  ]);
  const control = shell.slice(
    shell.indexOf("export function ArmedClearControl"),
    shell.indexOf("export function FormRow"),
  );
  assert.match(control, /if \(!armed\) \{[\s\S]*?onClick=\{onArm\}/, "the unarmed control may only arm");
  // The wipe is gated in both states. Backing out stays possible whatever runs.
  assert.match(control, /onClick=\{onConfirm\}\s*disabled=\{busy \|\| disabled\}/);
  assert.match(control, /onClick=\{onCancel\}\s*disabled=\{busy\}/);

  // A caller that passed the clear as `onArm` would wipe on the first press.
  assert.match(fitness, /<ArmedClearControl/);
  assert.doesNotMatch(fitness, /confirm\([\s\S]{0,80}Delete all/);
  assert.match(fitness, /onArm=\{\(\) => setClearArmed\(true\)\}/, "the first press may only arm");
  assert.doesNotMatch(fitness, /onArm=\{[^}]*clearAll/, "arming must not be the clear");
  // An armed "Delete all 12 workouts" over a list that has since changed is a lie.
  assert.match(
    fitness,
    /useEffect\(\(\) => \{\s*setClearArmed\(false\);\s*\}, \[sessions\.length\]\);/,
    "the armed control must reset when the list moves under it",
  );
});
