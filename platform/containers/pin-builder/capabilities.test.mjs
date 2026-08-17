import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOT = path.join(WORKSPACE_ROOT, "pin");
const SCRIPT = path.join(
  WORKSPACE_ROOT,
  "platform/containers/pin-builder/capabilities.sh",
);

function write(root, relativePath, contents) {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents, "utf8");
}

function run(script, args = [], sourceRoot = ROOT) {
  return execFileSync("bash", [script, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, AI_PIN_SOURCE_ROOT: sourceRoot },
  });
}

function createFixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "penumbra-capability-manifest-"),
  );
  const fixtureScript = path.join(
    root,
    "platform/containers/pin-builder/capabilities.sh",
  );
  write(
    root,
    "platform/containers/pin-builder/capabilities.sh",
    fs.readFileSync(SCRIPT, "utf8"),
  );
  write(
    root,
    "runtime/core/src/services/aibus/tools/catalog.rs",
    `fn read_specs() {
    name: "knowledge_lookup",
}
fn mutation_specs() {
    name: "set_timer",
}
const PLAY_MUSIC_TOOL: &str = "play_music";
`,
  );
  write(
    root,
    "runtime/core/src/services/aibus/tools/stock_agent.rs",
    `enum StockIntent {
    Timer,
    Alarm,
}
fn timer_v1_functions() {
    native_actions::SET_TIMER.to_string(),
    native_actions::EDIT_TIMER.to_string(),
    native_actions::SET_TIMER.to_string(),
}
fn alarm_v1_functions() {
    native_actions::CANCEL_ALARM.to_string(),
}
fn contacts_v1_functions() {
    native_actions::SEARCH_CONTACT.to_string(),
}
fn settings_v3_functions() {
    native_actions::DEVICE_STATUS.to_string(),
}
fn food_v4_functions() {
    "RetrieveFoodInfo".to_string(),
    "TrackFoodConsumption".to_string(),
    "GetFoodLog".to_string(),
}
`,
  );
  write(
    root,
    "runtime/core/src/config.rs",
    `fn default_max_tool_turns() -> usize {
    4
}
`,
  );
  write(
    root,
    "runtime/core/src/synapse/chat_turn_loop.rs",
    `const DEFAULT_GRACE_RESERVE: Duration = Duration::from_secs(8);
const SLOW_STEP_CUE_AFTER: Duration = Duration::from_secs(6);
`,
  );
  write(
    root,
    "runtime/core/src/services/aibus/stock_deadline.rs",
    `const STOCK_TURN_DEADLINE: Duration = Duration::from_secs(90);
`,
  );
  write(
    root,
    "runtime/core/src/services/aibus/turn/orchestration.rs",
    `const HTTP_PROVIDER_MODEL_STEP_TIMEOUT: Duration = Duration::from_secs(60);
`,
  );
  write(
    root,
    "runtime/core/src/synapse/catalog.rs",
    `pub static NATIVE_ACTION_CATALOG: &[NativeActionSpec] = &[
    action_spec!(
        native_actions::SET_TIMER,
    ),
    action_spec!(
        native_actions::DEVICE_STATUS,
    ),
];
`,
  );
  write(
    root,
    "runtime/core/src/tier_a.rs",
    `pub mod native_actions {
    pub const CANCEL_ALARM: &str = "CancelAlarm";
    pub const DEVICE_STATUS: &str = "DeviceStatus";
    pub const EDIT_TIMER: &str = "EditTimer";
    pub const SEARCH_CONTACT: &str = "SearchContact";
    pub const SET_TIMER: &str = "SetTimer";
}
`,
  );
  return { root, fixtureScript };
}

test("capability manifest resolves generated native-action symbols", () => {
  assert.match(run(SCRIPT, ["--check"]), /capability manifest is in sync/);

  const fixture = createFixture();
  try {
    const generated = run(fixture.fixtureScript, [], fixture.root);
    assert.match(
      generated,
      /Routed tool names in v1\/v3\/v4 function schemas: \*\*8\*\*/,
      "five distinct generated actions plus three stock-only food names",
    );
    write(
      fixture.root,
      "contracts/capabilities.txt",
      generated,
    );
    assert.match(
      run(fixture.fixtureScript, ["--check"], fixture.root),
      /capability manifest is in sync/,
    );

    const stockAgent = path.join(
      fixture.root,
      "runtime/core/src/services/aibus/tools/stock_agent.rs",
    );
    fs.appendFileSync(
      stockAgent,
      `fn settings_v3_functions() {
    native_actions::MISSING_ACTION.to_string(),
}
`,
      "utf8",
    );
    const red = spawnSync("bash", [fixture.fixtureScript, "--check"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, AI_PIN_SOURCE_ROOT: fixture.root },
    });
    assert.notEqual(red.status, 0, "an unresolved generated symbol must go red");
    assert.match(
      red.stderr,
      /unresolved generated native action symbol: MISSING_ACTION/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
