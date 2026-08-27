// Tests for the tool-coverage sweep.
//
// Run: node --test platform/deploy/acceptance/pin/tool-coverage.test.mjs   (no device, no network)
//
// These exist because the sweep reported "0 reached" across 37 capabilities and
// the product was fine. Three separate instrument defects produced that
// headline, and NOTHING could see any of them:
//   1. 21 mutation tools were scored by `okTools`, which they never write to —
//      an expectation that can never be met and a check that can never trip.
//   2. Five rows were declared as reads when the product registers them as
//      mutation specs.
//   3. The answer extractor called `require()` inside an ESM module and the
//      throw was swallowed by a bare `catch {}`, so the load-bearing backend
//      guard could never observe a decoded answer.
//
// Every case here is pure data and must be able to go RED. The ones that
// separate a correct implementation from a plausible-looking wrong one are
// marked LOAD-BEARING.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";

import { NATIVE_ACTIONS } from "./tier-a-symbols.mjs";

import {
  COVERAGE_CASES,
  GATES,
  KNOWN_ABSENT_NAMES,
  KNOWN_UNEMITTABLE_ACTION_NAMES,
  REPO_ROOT,
  WORKSPACE_ROOT,
  UNIVERSAL_TERMINAL_ACTION,
  buildPinboxProbeInvocation,
  buildProbeResult,
  classify,
  isDirectInvocation,
  parseArgs,
  parseEvidence,
  readProductCatalogs,
  selectCases,
  validateCaseNames,
  validateCaseShape,
} from "./tool-coverage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const catalogs = readProductCatalogs();

// A synthetic case shaped like the public classifier input, so the test does
// not silently exercise a shape the sweep never produces.
const caseOf = (overrides) => ({
  id: "test-case",
  capability: "Test capability",
  tool: "knowledge_lookup",
  actions: [],
  successSignal: "tool-ok",
  prompt: "test prompt",
  note: "test",
  ...overrides,
});

// The probe bundle shape classify() consumes, defaulted to "nothing happened".
const probeOf = (overrides) => ({
  latencyMs: 1_000,
  error: null,
  okTools: [],
  failedTools: [],
  plannedActions: [],
  answer: "",
  answerStatus: "ok",
  logcatMarkerFound: true,
  logcatRead: true,
  providerDeclined: false,
  mutations: [],
  mutationsRejected: [],
  replayed: [],
  terminalNativeTools: [],
  deterministicActions: [],
  ...overrides,
});

// ---- classify(): the two surfaces ---------------------------------------

test("classify: a read tool that executed ok is reached", () => {
  const verdict = classify(caseOf({}), probeOf({ okTools: ["knowledge_lookup"] }));
  assert.equal(verdict.status, "reached");
  assert.equal(verdict.covered, true);
  assert.equal(verdict.route, "read-tool");
});

test("LOAD-BEARING classify: a capability that arrives as a NATIVE ACTION is covered, not not-elicited", () => {
  // A planned native action does not appear in okTools. Looking only for a
  // read-tool result would incorrectly score this shape as not elicited.
  //
  // Vocabulary note: the status is `planned`, not `reached`, and `covered` is
  // the flag that answers "did this capability work". A mutation is handed to
  // stock for dispatch and this harness refuses to dispatch it, so calling it
  // "reached" would claim an execution that never happened.
  const testCase = caseOf({
    id: "am_i_online",
    tool: "am_i_online",
    actions: ["AmIOnline"],
    successSignal: "action-planned",
  });
  const verdict = classify(testCase, probeOf({ plannedActions: ["AmIOnline"] }));
  assert.equal(verdict.covered, true, "a native-action capability must count as covered");
  assert.notEqual(verdict.status, "not-elicited", "this is the exact false-negative that produced 0 reached");
  assert.equal(verdict.status, "planned");
  assert.equal(verdict.route, "native-action");
});

test("LOAD-BEARING classify: a mutation row with an EMPTY okTools is still covered", () => {
  // This synthetic shape has a planned mutation and an intentionally empty
  // okTools array. Under the old rule it was incorrectly a coverage gap.
  const testCase = caseOf({
    id: "decrement_volume",
    tool: "decrement_volume",
    actions: ["DecrementVolume"],
    successSignal: "action-planned",
  });
  const verdict = classify(testCase, probeOf({
    plannedActions: ["DecrementVolume"],
    mutations: [{ tool: "decrement_volume", action: "DecrementVolume" }],
    okTools: [],
  }));
  assert.equal(verdict.status, "planned");
  assert.equal(verdict.covered, true);
  assert.match(verdict.detail, /MODEL selected decrement_volume/);
});

test("classify: the accepted-action set covers the pre-agentic clock split (Alarm as well as SetAlarm)", () => {
  // plan_clock_family_action (understand.rs:95-122) returns the stock entry
  // action Alarm; the set_alarm tool would return SetAlarm. Both are correct,
  // so a single-name expectation would false-negative half the time.
  const testCase = caseOf({
    id: "set_alarm",
    tool: "set_alarm",
    actions: ["Alarm", "SetAlarm"],
    successSignal: "action-planned",
  });
  for (const observed of ["Alarm", "SetAlarm"]) {
    const verdict = classify(testCase, probeOf({ plannedActions: [observed] }));
    assert.equal(verdict.status, "planned", `${observed} should satisfy the clock capability`);
  }
});

test("LOAD-BEARING classify: a DIFFERENT action does not satisfy a mutation row", () => {
  // Before this, `planned` accepted any non-Respond action, so "play my
  // favourites" answering with PlayFeaturedMusic scored green.
  const testCase = caseOf({
    id: "play_favorite_tracks",
    tool: "play_favorite_tracks",
    actions: ["PlayFavoriteTracks"],
    successSignal: "action-planned",
  });
  const verdict = classify(testCase, probeOf({ plannedActions: ["PlayFeaturedMusic"] }));
  assert.equal(verdict.covered, false);
  assert.equal(verdict.status, "other-tool");
  assert.match(verdict.detail, /PlayFeaturedMusic/);
});

// ---- classify(): ordering -----------------------------------------------

test("LOAD-BEARING classify: backend failure outranks a successful tool line", () => {
  // The ordering is the whole point: backend failure invalidates an otherwise
  // positive line and must never be presented as successful coverage.
  const verdict = classify(
    caseOf({}),
    probeOf({
      okTools: ["knowledge_lookup"],
      answer: "Codex is unavailable on the host. Check its login status.",
    }),
  );
  assert.equal(verdict.status, "backend");
  assert.equal(verdict.covered, false);
});

test("classify: providerDeclined alone is enough for backend", () => {
  const verdict = classify(caseOf({}), probeOf({ providerDeclined: true }));
  assert.equal(verdict.status, "backend");
});

test("LOAD-BEARING classify: a declared gate string outranks the generic backend guard", () => {
  // The food-permit reply contains "is unavailable", so the generic guard
  // scored a correct, deliberate product answer as a backend OUTAGE
  // (food.rs:50-51). It is a gate, not an outage.
  const testCase = caseOf({
    id: "food_lookup",
    tool: "food_lookup",
    actions: ["ManageNutrition"],
    successSignal: "either",
    gate: GATES.foodRuntimePermit,
  });
  const verdict = classify(testCase, probeOf({
    answer: "Food and nutrition is disabled or its device setting is unavailable. I won't use a food provider.",
  }));
  assert.equal(verdict.status, "gated");
  assert.equal(verdict.gate, "food-runtime-permit");
});

test("classify: the same answer WITHOUT a declared gate stays a backend failure", () => {
  // Proves the gate branch is scoped to the case that declares it rather than
  // being a blanket softening of the backend guard.
  const verdict = classify(caseOf({}), probeOf({
    answer: "Food and nutrition is disabled or its device setting is unavailable.",
  }));
  assert.equal(verdict.status, "backend");
});

// ---- classify(): failure, rejection, gating, unscoreable ----------------

test("classify: a tool that ran and returned ok=false is failed", () => {
  const testCase = caseOf({ id: "current_weather", tool: "current_weather" });
  const verdict = classify(testCase, probeOf({
    failedTools: ["current_weather (current location is unavailable)"],
  }));
  assert.equal(verdict.status, "failed");
  assert.equal(verdict.covered, false);
  assert.match(verdict.detail, /current location is unavailable/);
});

test("LOAD-BEARING classify: a grounding refusal is `rejected`, not `not-elicited`", () => {
  // `<<< hermes mutation rejected` is parsed by neither pinbox nor the old
  // sweep, so "the model never asked" and "a gate refused the model's call"
  // were the same observation.
  const testCase = caseOf({
    id: "send_message",
    tool: "send_message",
    actions: ["ComposeMessage"],
    successSignal: "action-planned",
  });
  const verdict = classify(testCase, probeOf({
    mutationsRejected: [{ tool: "send_message", reason: "recipient not in this turn" }],
  }));
  assert.equal(verdict.status, "rejected");
  assert.equal(verdict.covered, false);
  assert.match(verdict.detail, /recipient not in this turn/);
});

test("classify: an absent capability that is hidden by a gate is `gated`, not a coverage gap", () => {
  const testCase = caseOf({ id: "web_search", tool: "web_search", gate: GATES.braveSubscriptionKey });
  const verdict = classify(testCase, probeOf({}));
  assert.equal(verdict.status, "gated");
  assert.equal(verdict.gate, "brave-subscription-key");
  assert.match(verdict.detail, /NOT a coverage gap/);
});

test("classify: disabled vision and fitness-start gates are explicit, while always-reachable cleanup stays measurable", () => {
  for (const id of ["AddIfThenEntry", "ClearIfThenMap", "GetIfThenMapSize", "StartActivityTracker"]) {
    const testCase = COVERAGE_CASES.find((candidate) => candidate.id === id);
    assert.ok(testCase?.gate, `${id} must record its live feature gate`);
    const verdict = classify(testCase, probeOf({}));
    assert.equal(verdict.status, "gated", id);
  }

  for (const id of ["StopActivityTracker", "Tickle", "ChangeQuickAction"]) {
    const testCase = COVERAGE_CASES.find((candidate) => candidate.id === id);
    assert.ok(testCase, `${id} missing`);
    assert.equal(testCase.gate, undefined, `${id} must not hide a routing regression behind an off-by-default gate`);
    assert.equal(classify(testCase, probeOf({})).status, "not-elicited", id);
  }
});

test("classify: a location preflight is unscoreable, not a gap", () => {
  // A location preflight can be planned before the requested read tool. That
  // intermediate state is intentionally unscoreable.
  const testCase = caseOf({ id: "current_weather", tool: "current_weather" });
  const verdict = classify(testCase, probeOf({ plannedActions: ["GetCurrentLocation"] }));
  assert.equal(verdict.status, "unscoreable");
  assert.match(verdict.detail, /preflight/);
});

test("LOAD-BEARING classify: a degraded log window can never read as reached or not-elicited", () => {
  // With the boundary marker evicted, pinbox falls back to the WHOLE buffer
  // (pinbox/shared/logcat.mjs:37-43), which contains every earlier prompt in
  // the sweep. A positive from that window may belong to a different prompt.
  const testCase = caseOf({});
  const positive = classify(testCase, probeOf({ okTools: ["knowledge_lookup"], logcatMarkerFound: false }));
  assert.equal(positive.status, "unscoreable");
  assert.equal(positive.covered, false);
  assert.match(positive.detail, /degraded log window/);

  const negative = classify(testCase, probeOf({ logcatMarkerFound: false }));
  assert.equal(negative.status, "unscoreable");
});

test("classify: a frame-derived action still scores with a degraded log window", () => {
  // plannedActions come from the decoded response frames, not the log, so the
  // window has no bearing on them. Blanket-unscoreable would throw away good data.
  const testCase = caseOf({
    id: "am_i_online", tool: "am_i_online", actions: ["AmIOnline"], successSignal: "action-planned",
  });
  const verdict = classify(testCase, probeOf({ plannedActions: ["AmIOnline"], logcatMarkerFound: false }));
  assert.equal(verdict.status, "planned");
});

test("LOAD-BEARING classify: an unreadable answer artifact is unscoreable, never not-elicited", () => {
  // If the answer cannot be read the backend guard is INERT — which is exactly
  // the defect that made every previous run's `backend` branch unreachable.
  // Scoring such a row as a gap would repeat it silently.
  const verdict = classify(caseOf({}), probeOf({ answerStatus: "unreadable" }));
  assert.equal(verdict.status, "unscoreable");
  assert.match(verdict.detail, /answer artifact could not be read/);

  // ...but hard log evidence outranks it: an outage cannot retract a tool that
  // demonstrably ran and returned ok=false.
  const stillFailed = classify(
    caseOf({ id: "current_weather", tool: "current_weather" }),
    probeOf({ answerStatus: "unreadable", failedTools: ["current_weather (no location)"] }),
  );
  assert.equal(stillFailed.status, "failed");
});

test("classify: prose-only is distinguished from silence", () => {
  // A prose decline is different from a silent turn. The detail has to retain
  // that distinction so the result can be investigated deterministically.
  const spoke = classify(caseOf({}), probeOf({ answer: "I can't access your battery level right now." }));
  assert.equal(spoke.status, "not-elicited");
  assert.match(spoke.detail, /answered in prose only/);

  const silent = classify(caseOf({}), probeOf({ answer: "" }));
  assert.match(silent.detail, /nothing was spoken/);
});

test("classify: nothing at all is not-elicited", () => {
  const verdict = classify(caseOf({}), probeOf({}));
  assert.equal(verdict.status, "not-elicited");
  assert.equal(verdict.covered, false);
});

test("classify: a probe error outranks everything", () => {
  const verdict = classify(caseOf({}), probeOf({ error: "adb: device offline", okTools: ["knowledge_lookup"] }));
  assert.equal(verdict.status, "probe-error");
});

test("classify: a replay line proves the tool ran when its executed line was evicted", () => {
  // A replay line can be the only surviving bounded evidence that a tool ran.
  const testCase = caseOf({ id: "music_catalog_search", tool: "music_catalog_search" });
  const verdict = classify(testCase, probeOf({
    replayed: [{ tool: "music_catalog_search", ok: true }],
  }));
  assert.equal(verdict.status, "reached");
});

test("LOAD-BEARING classify: unlockRequired alone never produces `gated`", () => {
  // The probe encodes is_locked = 0 explicitly
  // (platform/deploy/acceptance/pin/agentic-release-smoke-lib.mjs:545-560), so unlock gates are
  // satisfied by construction. Marking those eight reads `gated` would MASK
  // eight real coverage gaps behind a status that reads as "fine".
  const testCase = caseOf({ id: "memory_search", tool: "memory_search", unlockRequired: true });
  const verdict = classify(testCase, probeOf({}));
  assert.equal(verdict.status, "not-elicited");
});

// ---- the existence guard -------------------------------------------------

test("guard: the product catalogs actually parsed", () => {
  // If the Rust source shape changes and the parse silently returns nothing,
  // every membership check below becomes vacuous. Fail here instead.
  assert.equal(catalogs.available, true, catalogs.reason ?? "catalogs unavailable");
  assert.ok(catalogs.readTools.size >= 14, `read_specs parsed ${catalogs.readTools.size}, expected >= 14`);
  assert.equal(catalogs.writeTools.size, 1, "write_specs should hold exactly remember_fact");
  assert.ok(catalogs.mutationTools.size >= 22, `mutation_specs + play_music parsed ${catalogs.mutationTools.size}, expected >= 22`);
  assert.ok(catalogs.actions.size >= 80, `NATIVE_ACTION_CATALOG parsed ${catalogs.actions.size}, expected >= 80`);
  for (const anchor of ["knowledge_lookup", "remember_fact", "am_i_online", "play_music"]) {
    assert.ok(catalogs.tools.has(anchor), `${anchor} missing from the parsed tool catalog`);
  }
});

test("LOAD-BEARING guard: no case names a tool or action the product does not have", () => {
  const problems = validateCaseNames(COVERAGE_CASES, catalogs);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("LOAD-BEARING guard: it is LIVE — a bogus tool name is reported", () => {
  // Proves the guard can go red. Without this the guard could be vacuous and
  // look identical to a clean sweep, which is the failure mode it exists for.
  const problems = validateCaseNames(
    [caseOf({ id: "bogus", tool: "definitely_not_a_real_tool" })],
    catalogs,
  );
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /definitely_not_a_real_tool/);
  assert.match(
    problems[0],
    /tools\/catalog\.rs/,
    "the message must cite the file so it is fixable in one step",
  );
});

test("LOAD-BEARING guard: it is LIVE — a bogus action name is reported", () => {
  const problems = validateCaseNames(
    [caseOf({ id: "bogus", tool: null, actions: ["DefinitelyNotAnAction"], successSignal: "action-planned" })],
    catalogs,
  );
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /DefinitelyNotAnAction/);
  assert.match(problems[0], /synapse\/catalog\.rs/);
});

test("LOAD-BEARING guard: the names already known to be wrong are named explicitly", () => {
  // `current_time` and `TakePhoto` were asserted for weeks in prompt-suite and
  // exist nowhere in the product. A regression must be reported by NAME, with
  // the replacement, not as a generic "unknown".
  for (const [absent, replacement] of Object.entries(KNOWN_ABSENT_NAMES)) {
    const asTool = /^[a-z0-9_]+$/.test(absent);
    const problems = validateCaseNames(
      [asTool
        ? caseOf({ id: "regression", tool: absent })
        : caseOf({ id: "regression", tool: null, actions: [absent], successSignal: "action-planned" })],
      catalogs,
    );
    assert.ok(problems.length >= 1, `${absent} was accepted`);
    assert.match(problems[0], /DOES NOT EXIST/);
    assert.match(problems[0], new RegExp(replacement.split(" ")[0].replace(/[^\w]/g, "")));
  }
});

test("LOAD-BEARING guard: KNOWN_ABSENT_NAMES is not stale — none of them exists in the source", () => {
  const toolCatalogSource = readFileSync(
    path.join(REPO_ROOT, catalogs.sources.toolCatalog),
    "utf8",
  );
  const catalog = readFileSync(path.join(REPO_ROOT, catalogs.sources.actionCatalog), "utf8");
  for (const absent of Object.keys(KNOWN_ABSENT_NAMES)) {
    assert.ok(
      !toolCatalogSource.includes(`"${absent}"`) && !catalog.includes(`"${absent}"`),
      `"${absent}" now EXISTS in the product — KNOWN_ABSENT_NAMES is stale`,
    );
  }
});

test("LOAD-BEARING guard: an action that exists but can never be EMITTED is rejected", () => {
  // DeviceStatus is in NATIVE_ACTION_CATALOG, so a membership check passes —
  // yet Understand returns Settings containing a nested DeviceStatus Request
  // (native_device_actions.rs:225-236). Expecting DeviceStatus is a name that
  // can never match, the same defect wearing a different hat.
  const problems = validateCaseNames(
    [caseOf({ id: "device-status", tool: null, actions: ["DeviceStatus"], successSignal: "action-planned" })],
    catalogs,
  );
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /can never return it/);
  assert.match(problems[0], /Settings/);
});

test("guard: KNOWN_UNEMITTABLE_ACTION_NAMES is not stale — each still exists in the catalog", () => {
  // These are only worth listing because they LOOK valid. If one is deleted
  // server-side the entry is dead weight and should go.
  for (const name of Object.keys(KNOWN_UNEMITTABLE_ACTION_NAMES)) {
    assert.ok(catalogs.actions.has(name), `${name} is gone from the catalog — the unemittable list is stale`);
  }
});

test("LOAD-BEARING guard: a MUTATION tool scored by okTools is rejected", () => {
  // This is the defect stated as a rule. A mutation returns
  // ToolExecutionOutcome::Terminal (tools/catalog.rs:2570-2573) and logs no
  // executed line, so `okTools` can never contain it — in either direction.
  const problems = validateCaseNames(
    [caseOf({ id: "bad", tool: "am_i_online", actions: ["AmIOnline"], successSignal: "tool-ok" })],
    catalogs,
  );
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /MUTATION spec/);
  assert.match(problems[0], /AmIOnline/, "the message must name the action to use instead");
});

test("guard: a READ tool scored only by a planned action is rejected", () => {
  const problems = validateCaseNames(
    [caseOf({ id: "bad", tool: "knowledge_lookup", actions: ["Respond"], successSignal: "action-planned" })],
    catalogs,
  );
  assert.ok(problems.some((p) => /READ\/WRITE spec/.test(p)), problems.join("\n"));
});

test("LOAD-BEARING guard: the universal terminal `Respond` can never be a success name", () => {
  // Every spoken turn emits Respond, so expecting it is an assertion that can
  // never FAIL — as useless as one that can never pass, and far more dangerous
  // because it reads as green.
  const problems = validateCaseNames(
    [caseOf({ id: "bad", tool: null, actions: [UNIVERSAL_TERMINAL_ACTION], successSignal: "action-planned" })],
    catalogs,
  );
  assert.ok(problems.some((p) => /universal text terminal/.test(p)), problems.join("\n"));
  for (const testCase of COVERAGE_CASES) {
    assert.ok(
      !(testCase.actions ?? []).includes(UNIVERSAL_TERMINAL_ACTION),
      `${testCase.id} expects Respond`,
    );
  }
});

test("LOAD-BEARING guard: a declared gate string matches implementation text", () => {
  // A gate that matches nothing the implementation says is another invisible name:
  // the row would silently fall through to `backend` forever.
  for (const gate of Object.values(GATES)) {
    if (!gate.answerLiteral) continue;
    const source = readFileSync(path.join(REPO_ROOT, gate.answerLiteralSource), "utf8");
    assert.ok(source.includes(gate.answerLiteral), `${gate.id}: "${gate.answerLiteral}" is not in ${gate.answerLiteralSource}`);
    assert.ok(gate.answerPattern.test(gate.answerLiteral), `${gate.id}: its own literal does not match its own pattern`);
  }
});

// ---- case-list integrity -------------------------------------------------

test("LOAD-BEARING cases: no duplicate capability entries", () => {
  const problems = validateCaseShape(COVERAGE_CASES);
  assert.deepEqual(problems, [], problems.join("\n"));

  const ids = COVERAGE_CASES.map((c) => c.id);
  const capabilities = COVERAGE_CASES.map((c) => c.capability);
  const prompts = COVERAGE_CASES.map((c) => c.prompt);
  assert.equal(new Set(ids).size, ids.length, "duplicate id");
  assert.equal(new Set(capabilities).size, capabilities.length, "duplicate capability");
  assert.equal(new Set(prompts).size, prompts.length, "duplicate prompt");
});

test("cases: the duplicate check is LIVE", () => {
  const dup = { ...COVERAGE_CASES[0] };
  const problems = validateCaseShape([COVERAGE_CASES[0], dup]);
  assert.ok(problems.some((p) => /duplicate case id/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /duplicate capability/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /duplicate prompt/.test(p)), problems.join("\n"));
});

test("cases: every native-only wearer capability is represented", () => {
  // Each of these has NO hermes tool at all, so it is reachable only through an
  // exact deterministic phrase — the highest-risk unreachable shape and the one
  // a tool-name-only sweep is structurally blind to.
  for (const id of [
    "CapturePhotograph",
    "PlayCurrentTrackRadio",
    "Translate",
    "WorldClock",
    "CatchMeUp",
    "MessageSearch",
    "GetBluetoothStatus",
    "GetAirplaneModeStatus",
    "Settings",
    "ClearUnderstandingContext",
    "CaptureVideo",
    "StopVideo",
    "OpenRecentPhotos",
    "LockDevice",
    "EnterPrivacyMode",
    "StartActivityTracker",
    "StopActivityTracker",
    "OpenTutorial",
    "GetPhoneNumber",
    "GetSerialNumber",
    "connect_bluetooth_device",
    "disconnect_bluetooth_device",
    "Tickle",
    "AddIfThenEntry",
    "ClearIfThenMap",
    "GetIfThenMapSize",
    "ChangeQuickAction",
    "ConnectToWifi",
    "CreateContact",
    "DisconnectWifi",
    "FactoryReset",
    "Reboot",
    "SetUpTouchcode",
    "TrustLock",
    "TurnOffAirplaneMode",
    "TurnOffAmberAlert",
    "TurnOffBluetooth",
    "TurnOffCellularData",
    "TurnOffCellularRoaming",
    "TurnOffDevice",
    "TurnOffEmergencyAlert",
    "TurnOffPublicSafetyAlert",
    "TurnOffWifi",
    "TurnOnAirplaneMode",
    "TurnOnAmberAlert",
    "TurnOnBluetooth",
    "TurnOnCellularData",
    "TurnOnCellularRoaming",
    "TurnOnEmergencyAlert",
    "TurnOnPublicSafetyAlert",
    "TurnOnWifi",
    "WifiQrScan",
  ]) {
    const testCase = COVERAGE_CASES.find((c) => c.id === id);
    assert.ok(testCase, `${id} is missing from the sweep`);
    assert.equal(testCase.tool, null, `${id} has no hermes tool in the product`);
  }
  assert.equal(COVERAGE_CASES.length, 89, "the exhaustive wearer catalog changed; add or remove an audited case deliberately");
});

test("LOAD-BEARING cases: every contract action emitted by the native_device_actions module is represented", () => {
  const contracts = readFileSync(
    path.join(REPO_ROOT, "contracts/tier-a/native-actions.tsv"),
    "utf8",
  )
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t"))
    .filter((columns) => columns[6]?.startsWith("runtime/core/src/synapse/native_device_actions"))
    .map((columns) => columns[0]);

  const represented = new Set(
    COVERAGE_CASES.flatMap((testCase) => [
      ...(testCase.actions ?? []),
      ...(testCase.stagedActions ?? []),
    ]),
  );
  assert.equal(contracts.length, 53, "the native-device contract surface changed; audit the new source route");
  assert.deepEqual(
    contracts.filter((action) => !represented.has(action)),
    [],
    "a native-device action is absent from the exhaustive coverage catalog",
  );

  const location = COVERAGE_CASES.find((candidate) => candidate.id === "current_location");
  assert.deepEqual(location?.stagedActions, [NATIVE_ACTIONS.GET_CURRENT_LOCATION]);
  assert.deepEqual(location?.actions, [], "the preflight must never count as completed location delivery");
});

test("cases: the five rows that were mis-declared as reads are mutation-scored", () => {
  for (const id of ["get_current_time", "get_battery_level", "am_i_online", "get_current_volume", "get_music_queue"]) {
    const testCase = COVERAGE_CASES.find((c) => c.id === id);
    assert.ok(testCase, `${id} missing`);
    assert.equal(testCase.successSignal, "action-planned", `${id} is a mutation spec and cannot be scored by okTools`);
    assert.ok(catalogs.mutationTools.has(testCase.tool), `${id} should be in mutation_specs`);
  }
});

test("cases: locationDependent is on current_location alone", () => {
  // It is the only read with external_device_preflight: Some("GetCurrentLocation")
  // (catalog.rs:931). The others return ok=false with a reason, which is a
  // real `failed` signal that the blanket flag was hiding.
  const flagged = COVERAGE_CASES.filter((c) => c.locationDependent).map((c) => c.id);
  assert.deepEqual(flagged, ["current_location"]);
});

test("cases: --only selects by id, tool name or action name", () => {
  assert.deepEqual(selectCases(COVERAGE_CASES, ["am_i_online"]).map((c) => c.id), ["am_i_online"]);
  assert.deepEqual(selectCases(COVERAGE_CASES, ["CapturePhotograph"]).map((c) => c.id), ["CapturePhotograph"]);
  assert.equal(selectCases(COVERAGE_CASES, null).length, COVERAGE_CASES.length);
});

// ---- evidence parsing ----------------------------------------------------
//
// Fully synthetic fixtures preserve the implemented tracing grammar. A log
// format change still breaks the parser tests, but no device timestamps,
// process IDs, correlations, or wearer content are embedded here.

const LOG_PREFIX = "         1700000000.000  100  200 W PenumbraServer:  INFO ";
const line = (body) => `${LOG_PREFIX}${body}`;

const SYNTHETIC_LINES = {
  executedOk: line("humane_server::services::aibus::tools::catalog: <<< hermes tool executed correlation=synthetic-read-ok tool=current_music ok=true"),
  executedFail: line("humane_server::services::aibus::tools::catalog: <<< hermes tool executed correlation=synthetic-read-fail tool=current_weather ok=false reason=current location is unavailable"),
  mutation: line('humane_server::services::aibus::tools::catalog: <<< hermes mutation tool=decrement_volume action="DecrementVolume"'),
  terminalNative: line("humane_server::synapse::chat_turn_loop: <<< hermes terminal native action correlation=synthetic-native tool=decrement_volume"),
  replay: line("humane_server::synapse::chat_turn_loop: <<< hermes replaying identical observation from this turn correlation=synthetic-replay tool=music_catalog_search ok=true"),
  deterministic: line('humane_server::services::aibus::tools::catalog: <<< completing device control deterministically; the model would not action="IncrementVolume"'),
  // Synthetic but emitter-accurate: tools/catalog.rs:3048-3056 formats the
  // model's own (possibly hallucinated) call name into tool=.
  camelCaseUnknown: line('humane_server::services::aibus::tools::catalog: <<< hermes tool executed correlation=x tool=AmIOnline ok=false reason="unknown_tool"'),
  rejected: line('humane_server::services::aibus::tools::catalog: <<< hermes mutation rejected: not grounded in this turn tool=send_message reason=recipient not in this turn'),
};

test("parseEvidence: executed lines are parsed with ok and reason", () => {
  const evidence = parseEvidence([SYNTHETIC_LINES.executedOk, SYNTHETIC_LINES.executedFail].join("\n"));
  assert.deepEqual(evidence.executed, [
    { tool: "current_music", ok: true, reason: null },
    { tool: "current_weather", ok: false, reason: "current location is unavailable" },
  ]);
});

test("LOAD-BEARING parseEvidence: a CamelCase tool name is visible", () => {
  // pinbox's class is [a-z_], so a hallucinated CamelCase name in an
  // `unknown_tool` failure produces NO entry at all — the model's mistake
  // becomes indistinguishable from the model never calling anything.
  const evidence = parseEvidence(SYNTHETIC_LINES.camelCaseUnknown);
  assert.deepEqual(evidence.executed, [{ tool: "AmIOnline", ok: false, reason: "unknown_tool" }]);
});

test("LOAD-BEARING parseEvidence: a mutation marker is parsed and kept OUT of the tool results", () => {
  // A mutation the model PROPOSED must never be reported as one the planner
  // performed, and it must never be confused with an executed read.
  const evidence = parseEvidence(SYNTHETIC_LINES.mutation);
  assert.deepEqual(evidence.mutations, [{ tool: "decrement_volume", action: "DecrementVolume" }]);
  assert.deepEqual(evidence.executed, []);
});

test("parseEvidence: a mutation REJECTION is not read as a mutation", () => {
  const evidence = parseEvidence(SYNTHETIC_LINES.rejected);
  assert.deepEqual(evidence.mutations, [], "the rejected line must not count as an accepted mutation");
  assert.equal(evidence.mutationsRejected.length, 1);
  assert.equal(evidence.mutationsRejected[0].tool, "send_message");
  assert.match(evidence.mutationsRejected[0].reason, /recipient not in this turn/);
});

test("parseEvidence: replay, terminal-native and deterministic markers are separated", () => {
  const evidence = parseEvidence([
    SYNTHETIC_LINES.replay,
    SYNTHETIC_LINES.terminalNative,
    SYNTHETIC_LINES.deterministic,
  ].join("\n"));
  assert.deepEqual(evidence.replayed, [{ tool: "music_catalog_search", ok: true }]);
  assert.deepEqual(evidence.terminalNativeTools, ["decrement_volume"]);
  assert.deepEqual(evidence.deterministicActions, ["IncrementVolume"]);
  assert.deepEqual(evidence.executed, [], "none of these is an execution");
});

test("parseEvidence: an empty or absent window yields empty sets, never a throw", () => {
  for (const input of ["", null, undefined, 17]) {
    const evidence = parseEvidence(input);
    assert.deepEqual(evidence.executed, []);
    assert.deepEqual(evidence.mutations, []);
  }
});

// ---- bundle reading ------------------------------------------------------

const respondFrame = (text) => ({
  kind: "action",
  isFinal: false,
  user: 2,
  hasIdentifier: true,
  hasParentIdentifier: true,
  identifier: "id",
  parentIdentifier: "parent",
  thought: "I should return the final answer",
  action: "Respond",
  input: JSON.stringify({ Response: text }),
  devicePayloadBytes: 0,
  source: 1,
});

const bundleOf = (overrides = {}) => ({
  latencyMs: 4_200,
  probeError: null,
  okTools: [],
  failedTools: [],
  responses: { plannedActions: [], answerChars: 0, answerPreview: "" },
  logcatMarkerFound: true,
  providerDeclined: false,
  runDir: "/tmp/session-x/001-y",
  files: { responses: "/tmp/responses.json", logcat: "/tmp/logcat.log" },
  ...overrides,
});

test("LOAD-BEARING buildProbeResult: the spoken answer is actually extracted", () => {
  // The previous version called require() inside an ESM module; the throw was
  // swallowed by `catch {}` so `answer` was always empty and the backend guard
  // could not fire. This test is the one that goes red if that regresses.
  const io = {
    readJson: () => [respondFrame("Codex is unavailable on the host. Check its login status.")],
    readText: () => "",
  };
  const probe = buildProbeResult(bundleOf(), io);
  assert.equal(probe.answerStatus, "ok");
  assert.match(probe.answer, /Codex is unavailable/);
  assert.equal(classify(caseOf({}), probe).status, "backend");
});

test("buildProbeResult: an unreadable answer artifact is reported, not swallowed", () => {
  const io = { readJson: () => undefined, readText: () => "" };
  const probe = buildProbeResult(bundleOf(), io);
  assert.equal(probe.answerStatus, "unreadable");
  assert.equal(probe.answer, "");
});

test("LOAD-BEARING buildProbeResult: it UNIONS pinbox's arrays with the widened re-parse", () => {
  // pinbox already saw one tool; the re-parse adds the CamelCase entry its own
  // regex drops. Neither source may be lost.
  const io = {
    readJson: () => [respondFrame("ok")],
    readText: () => [SYNTHETIC_LINES.executedOk, SYNTHETIC_LINES.camelCaseUnknown].join("\n"),
  };
  const probe = buildProbeResult(bundleOf({ okTools: ["knowledge_lookup"] }), io);
  assert.deepEqual(probe.okTools.sort(), ["current_music", "knowledge_lookup"]);
  assert.ok(probe.failedTools.some((f) => f.startsWith("AmIOnline")), probe.failedTools.join(","));
});

test("buildProbeResult: mutation evidence reaches the probe result", () => {
  const io = { readJson: () => [], readText: () => SYNTHETIC_LINES.mutation };
  const probe = buildProbeResult(bundleOf({ responses: { plannedActions: ["DecrementVolume"] } }), io);
  assert.deepEqual(probe.mutations, [{ tool: "decrement_volume", action: "DecrementVolume" }]);
  assert.deepEqual(probe.okTools, []);
  assert.equal(probe.logcatRead, true);
});

test("buildProbeResult: a fatal pinbox bundle becomes a probe error", () => {
  assert.match(buildProbeResult({ fatal: "the device is offline" }).error, /device is offline/);
  assert.match(buildProbeResult(null).error, /not JSON/);
});

test("buildProbeResult: machinery leaking into speech is flagged", () => {
  const io = {
    readJson: () => [respondFrame("<tool_call_result>Tool call failed: function not found</tool_call_result>")],
    readText: () => "",
  };
  assert.equal(buildProbeResult(bundleOf(), io).machineryLeak, true);
});

// ---- CLI -----------------------------------------------------------------

test("parseArgs: --serial is required for a sweep but not for --check-names", () => {
  assert.match(parseArgs([]).error, /--serial is required/);
  assert.equal(parseArgs(["--check-names"]).options.checkNames, true);
  assert.equal(parseArgs(["--serial", "YOUR_PIN_SERIAL"]).options.serial, "YOUR_PIN_SERIAL");
});

test("parseArgs: unknown arguments are refused rather than ignored", () => {
  assert.match(parseArgs(["--serial", "YOUR_PIN_SERIAL", "--dispatch"]).error, /unknown argument/);
});

test("parseArgs: non-numeric --settle-ms/--timeout-ms are refused, not turned into NaN", () => {
  // `Number("90k")` is NaN; unvalidated it would sleep for nothing and be handed
  // to the probe subprocess as the literal "NaN".
  assert.match(parseArgs(["--serial", "S", "--timeout-ms", "90k"]).error, /--timeout-ms/);
  assert.match(parseArgs(["--serial", "S", "--settle-ms", "abc"]).error, /--settle-ms/);
  assert.match(parseArgs(["--serial", "S", "--timeout-ms"]).error, /--timeout-ms/);
  assert.match(parseArgs(["--serial", "S", "--timeout-ms", "0"]).error, /--timeout-ms/);
  assert.match(parseArgs(["--serial", "S", "--settle-ms", "-1"]).error, /--settle-ms/);
  // Valid values and the defaults still pass.
  assert.equal(parseArgs(["--serial", "S", "--timeout-ms", "30000"]).options.timeoutMs, 30000);
  assert.equal(parseArgs(["--serial", "S", "--settle-ms", "0"]).options.settleMs, 0);
  assert.equal(parseArgs(["--serial", "S"]).options.timeoutMs, 90000);
});

test("isDirectInvocation matches only the exact module path, never a basename suffix", () => {
  const moduleUrl = pathToFileURL(path.join(HERE, "tool-coverage.mjs")).href;
  // Exact path (as `node platform/deploy/acceptance/pin/tool-coverage.mjs` would pass) is a direct run.
  assert.equal(isDirectInvocation(path.join(HERE, "tool-coverage.mjs"), moduleUrl), true);
  assert.equal(isDirectInvocation("tool-coverage.mjs", pathToFileURL(path.resolve("tool-coverage.mjs")).href), true);
  // The old `endsWith(basename)` test fired for these; the robust check must not.
  assert.equal(isDirectInvocation(path.join(HERE, "coverage.mjs"), moduleUrl), false);
  assert.equal(isDirectInvocation(path.join(HERE, "my-tool-coverage.mjs"), moduleUrl), false);
  assert.equal(isDirectInvocation(undefined, moduleUrl), false);
  assert.equal(isDirectInvocation("", moduleUrl), false);
});

test("LOAD-BEARING probe invocation uses canonical Pinbox in safe mode", () => {
  // Exercise the same pure builder the subprocess path consumes. This keeps
  // the safety contract falsifiable without scraping source formatting or a
  // stale pre-refactor path.
  const spawnArgs = buildPinboxProbeInvocation("fixture-serial", "safe prompt", 30_000);
  assert.deepEqual(spawnArgs, [
    "platform/deploy/acceptance/pin/pinbox.mjs",
    "probe",
    "--serial",
    "fixture-serial",
    "--prompt",
    "safe prompt",
    "--json",
    "--timeout-ms",
    "30000",
  ]);
  assert.equal(spawnArgs.includes("--dispatch"), false);
  assert.equal(
    existsSync(path.join(WORKSPACE_ROOT, spawnArgs[0])),
    true,
    "the workspace-relative Pinbox entry must resolve from the subprocess cwd",
  );
});
