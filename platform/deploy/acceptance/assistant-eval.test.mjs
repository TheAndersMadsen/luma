import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as evalModule from "../vps/assistant-eval.mjs";

import {
  ASSISTANT_CASES,
  agentRunSamples,
  assistantCurlCommand,
  assistantReport,
  assistantTracePayload,
  caseReplay,
  changedAgentRuns,
  evaluateAssistantCase,
  musicOwnerAction,
  optionalToolBlock,
  parseArguments,
  renderReport,
  selectAssistantCases,
} from "../vps/assistant-eval.mjs";

function sample(overrides = {}, value = 1) {
  const labels = {
    planner_plane: "cosmos_remote",
    transport: "legacy",
    route: "a1",
    model_invoked: "true",
    model_steps: "1",
    model_provider: "codex_subscription",
    model: "gpt-5.6-sol",
    model_speed: "fast",
    reasoning_effort: "low",
    terminal: "answered",
    ...overrides,
  };
  return `cosmos_agent_runs_total{${Object.entries(labels)
    .map(([name, label]) => `${name}="${label}"`)
    .join(",")}} ${value}\n`;
}

test("agent evaluation correlates the trace with an actual model run", () => {
  const spec = ASSISTANT_CASES.find(({ id }) => id === "fresh-web-search");
  const before = sample({}, 4);
  const after = sample({}, 5);
  const result = evaluateAssistantCase(
    spec,
    {
      steps: [
        { kind: "action", name: "web_search" },
        { kind: "observation", name: "web_search" },
        {
          kind: "answer",
          name: "Respond",
          text: "One current Denmark headline was returned.",
        },
      ],
      total_ms: 4200,
      device_deadline_ms: 25000,
    },
    before,
    after,
  );
  assert.equal(result.status, "pass", result.failures.join(","));
  assert.equal(result.run.model, "gpt-5.6-sol");
  assert.equal(changedAgentRuns(before, after)[0].delta, 1);
  assert.equal(agentRunSamples(after).size, 1);
});

test("deterministic success cannot masquerade as broad model reasoning", () => {
  const result = evaluateAssistantCase(
    ASSISTANT_CASES[0],
    {
      steps: [{ kind: "answer", name: "Respond" }],
      total_ms: 50,
      device_deadline_ms: 25000,
    },
    "",
    sample({ route: "d1", model_invoked: "false", model_steps: "0", terminal: "device_action" }),
  );
  assert.equal(result.status, "fail");
  assert.deepEqual(result.failures, ["missing_model_run"]);
});

test("an explicitly deterministic safety case correlates without pretending the model ran", () => {
  const spec = ASSISTANT_CASES.find(({ id }) => id === "tickle-near-miss");
  const before = sample(
    { route: "d1", model_invoked: "false", model_steps: "0", terminal: "device_action" },
    4,
  );
  const after = sample(
    { route: "d1", model_invoked: "false", model_steps: "0", terminal: "device_action" },
    5,
  );
  const result = evaluateAssistantCase(
    spec,
    {
      steps: [{
        kind: "answer",
        name: "Respond",
        text: "Tickle only runs for the exact supported phrases.",
      }],
      total_ms: 0,
      device_deadline_ms: 25000,
    },
    before,
    after,
  );

  assert.equal(result.status, "pass", result.failures.join(","));
  assert.equal(result.run.modelInvoked, false);
});

test("simulated Pin cases request device context and verify exact stock action input", () => {
  const apple = ASSISTANT_CASES.find(({ id }) => id === "pin-nutrition-apple");
  assert.deepEqual(assistantTracePayload(apple), {
    text: "How many calories are in an apple?",
    simulate_unlocked_pin: true,
  });
  assert.deepEqual(assistantTracePayload(ASSISTANT_CASES[0]), {
    text: "Explain in one sentence why the daytime sky appears blue.",
  });

  const before = sample(
    { route: "d1", model_invoked: "false", model_steps: "0", terminal: "device_action" },
    4,
  );
  const after = sample(
    { route: "d1", model_invoked: "false", model_steps: "0", terminal: "device_action" },
    5,
  );
  const passing = evaluateAssistantCase(
    apple,
    {
      steps: [{
        kind: "action",
        name: "ManageNutrition",
        input: JSON.stringify({ Request: apple.prompt }),
      }],
      total_ms: 1,
      device_deadline_ms: 90_000,
    },
    before,
    after,
  );
  assert.equal(passing.status, "pass", passing.failures.join(","));

  const wrongInput = evaluateAssistantCase(
    apple,
    {
      steps: [{
        kind: "action",
        name: "ManageNutrition",
        input: JSON.stringify({ Request: "a banana" }),
      }],
      total_ms: 1,
      device_deadline_ms: 90_000,
    },
    before,
    after,
  );
  assert.ok(wrongInput.failures.includes("action_input:ManageNutrition"));
});

test("explicit OS3 task delegation stays first, argument-free, and unlocked", () => {
  const spec = selectAssistantCases("os3-explicit-task", "LUMA-OS3-ROUND-A")[0];
  assert.match(spec.prompt, /quote exactly "monthly_report_final\.csv" and "2\*3 \+ 4\*5" in your response without interpreting or changing them/u);
  assert.match(spec.prompt, /then end with exactly LUMA-OS3-ROUND-A\./u);
  assert.ok(spec, "the production matrix must exercise explicit OS3 task delegation");
  assert.match(spec.prompt, /read-only task on my MacBook/iu);
  assert.doesNotMatch(spec.prompt, /wait five seconds/iu);
  assert.equal(spec.firstAction, "ask_os3");
  assert.deepEqual(spec.requiredActions, ["ask_os3", "Respond"]);
  assert.deepEqual(spec.expectedActionInputs, { ask_os3: {} });
  assert.equal(spec.exactActionCounts.ask_os3, 1);
  assert.deepEqual(spec.exactActionSequence, ["ask_os3", "Respond"]);
  assert.equal(spec.answerEqualsObservation, "ask_os3");
  assert.equal(spec.route, "d1");
  assert.equal(spec.modelInvoked, false);
  assert.equal(spec.simulateUnlockedPin, true);
  assert.equal(spec.authenticatedWearer, true);

  const trace = {
    steps: [
      { kind: "action", name: "ask_os3", input: "{}" },
      { kind: "observation", name: "ask_os3", text: "OS3 is still working on that task.", speakable_text: "OS3 is still working on that task." },
      { kind: "answer", name: "Respond", text: "OS3 is still working on that task." },
    ],
    total_ms: 12_000,
    device_deadline_ms: 90_000,
  };
  const deterministic = { route: "d1", model_invoked: "false" };
  const before = sample(deterministic, 4);
  const after = sample(deterministic, 5);
  assert.equal(evaluateAssistantCase(spec, trace, before, after).status, "pass");

  const falseCompletion = structuredClone(trace);
  falseCompletion.steps[2].text = "Done.";
  assert.ok(
    evaluateAssistantCase(spec, falseCompletion, before, after).failures.includes(
      "answer_observation_mismatch:ask_os3",
    ),
  );

  const companion = structuredClone(trace);
  companion.steps.splice(2, 0, {
    kind: "action",
    name: "recall_memory",
    input: '{"query":"instructions"}',
  });
  assert.ok(
    evaluateAssistantCase(spec, companion, before, after).failures.includes(
      "action_sequence:ask_os3>Respond",
    ),
  );

  trace.steps = [trace.steps[2], trace.steps[0], trace.steps[1]];
  assert.ok(
    evaluateAssistantCase(spec, trace, before, after).failures.includes("first_action:ask_os3"),
  );
});

test("a later OS3 status request retrieves the prior task result", () => {
  const spec = selectAssistantCases("os3-task-result", "LUMA-OS3-ROUND-A")[1];
  assert.ok(spec, "the production matrix must retrieve delegated OS3 work later");
  assert.equal(spec.firstAction, "ask_os3");
  assert.deepEqual(spec.expectedActionInputs, { ask_os3: {} });
  assert.equal(spec.exactActionCounts.ask_os3, 1);
  assert.deepEqual(spec.exactActionSequence, ["ask_os3", "Respond"]);
  assert.equal(spec.answerEqualsObservation, "ask_os3");
  assert.equal(spec.route, "d1");
  assert.equal(spec.modelInvoked, false);

  const deterministic = { route: "d1", model_invoked: "false" };
  const before = sample(deterministic, 8);
  const after = sample(deterministic, 9);
  const resultFor = (text) =>
    evaluateAssistantCase(
      spec,
      {
        steps: [
          { kind: "action", name: "ask_os3", input: "{}" },
          { kind: "observation", name: "ask_os3", text, speakable_text: text },
          { kind: "answer", name: "Respond", text },
        ],
        total_ms: 1_000,
        device_deadline_ms: 90_000,
      },
      before,
      after,
    );

  const complete = "Battery is at 82%. monthly_report_final.csv; 2*3 + 4*5. LUMA-OS3-ROUND-A";
  const result = resultFor(complete);
  assert.equal(result.status, "pass", result.failures.join(","));

  const markerOnly = resultFor("Earlier OS3 result: LUMA-OS3-ROUND-A");
  assert.ok(markerOnly.failures.includes("answer_mismatch"));

  const batteryOnly = resultFor("Battery is at 82%.");
  assert.ok(batteryOnly.failures.includes("answer_mismatch"));

  const anotherRound = resultFor(complete.replace("ROUND-A", "ROUND-B"));
  assert.ok(anotherRound.failures.includes("answer_mismatch"));

  for (const corrupted of [
    complete.replace("monthly_report_final.csv; ", ""),
    complete.replace("monthly_report_final.csv", "monthlyreportfinal.csv"),
    complete.replace("2*3 + 4*5. ", ""),
    complete.replace("2*3 + 4*5", "2*3 + 45"),
    complete.replace("2*3 + 4*5", "2 times 3 plus 4 times 5"),
    complete.replace("2*3 + 4*5", "26"),
  ]) {
    assert.ok(resultFor(corrupted).failures.includes("answer_mismatch"), corrupted);
  }

  const inventedResult = evaluateAssistantCase(
    spec,
    {
      steps: [
        { kind: "action", name: "ask_os3", input: "{}" },
        { kind: "observation", name: "ask_os3", text: "OS3 is still working on that task.", speakable_text: "OS3 is still working on that task." },
        { kind: "answer", name: "Respond", text: "Earlier OS3 result: LUMA-OS3-ROUND-A" },
      ],
      total_ms: 1_000,
      device_deadline_ms: 90_000,
    },
    before,
    after,
  );
  assert.ok(inventedResult.failures.includes("answer_observation_mismatch:ask_os3"));

  const pending = evaluateAssistantCase(
    spec,
    {
      steps: [
        { kind: "action", name: "ask_os3", input: "{}" },
        {
          kind: "observation",
          name: "ask_os3",
          text: "OS3 is still working on LUMA-OS3-ROUND-A.",
          speakable_text: "OS3 is still working on LUMA-OS3-ROUND-A.",
        },
        {
          kind: "answer",
          name: "Respond",
          text: "OS3 is still working on LUMA-OS3-ROUND-A.",
        },
      ],
      total_ms: 1_000,
      device_deadline_ms: 90_000,
    },
    before,
    after,
  );
  assert.ok(pending.failures.includes("answer_mismatch"));
});

test("OS3 result proof requires canonical speech and keeps independent pending work truthful", () => {
  // Unrecorded trace fixture: raw provider formatting remains in text. Cosmos
  // supplies speakable_text through its stock Respond speech normalization.
  const spec = selectAssistantCases("os3-task-result", "LUMA-OS3-ROUND-A")[1];
  const before = sample({ route: "d1", model_invoked: "false" }, 8);
  const after = sample({ route: "d1", model_invoked: "false" }, 9);
  const spoken = "OS3 replied: Battery is at 82%. monthly_report_final.csv; 2*3 + 4*5. LUMA-OS3-ROUND-A";
  const trace = {
    steps: [
      { kind: "action", name: "ask_os3", input: "{}" },
      { kind: "observation", name: "ask_os3", text: "OS3 replied: **Battery is at 82%.**\nmonthly_report_final.csv; 2*3 + 4*5. LUMA-OS3-ROUND-A", speakable_text: spoken },
      { kind: "answer", name: "Respond", text: spoken },
    ],
    total_ms: 1_000,
    device_deadline_ms: 90_000,
  };
  const evaluate = (value) => evaluateAssistantCase(spec, value, before, after);
  assert.equal(evaluate(trace).status, "pass");

  const missingCanonical = structuredClone(trace);
  missingCanonical.steps[1].text = spoken;
  delete missingCanonical.steps[1].speakable_text;
  assert.ok(evaluate(missingCanonical).failures.includes("answer_observation_mismatch:ask_os3"));
  const malformedCanonical = structuredClone(missingCanonical);
  malformedCanonical.steps[1].speakable_text = { text: spoken };
  assert.ok(evaluate(malformedCanonical).failures.includes("answer_observation_mismatch:ask_os3"));

  const rewritten = structuredClone(trace);
  rewritten.steps[2].text = "The battery is 82%. monthly_report_final.csv; 2*3 + 4*5. LUMA-OS3-ROUND-A";
  assert.ok(evaluate(rewritten).failures.includes("answer_observation_mismatch:ask_os3"));
  const missingObservation = structuredClone(trace);
  missingObservation.steps.splice(1, 1);
  assert.ok(evaluate(missingObservation).failures.includes("answer_observation_mismatch:ask_os3"));
  const duplicateObservation = structuredClone(trace);
  duplicateObservation.steps.splice(1, 0, structuredClone(trace.steps[1]));
  assert.ok(evaluate(duplicateObservation).failures.includes("answer_observation_mismatch:ask_os3"));

  // A completed battery read does not imply every Rabbit task has finished.
  const pendingElsewhere = structuredClone(trace);
  const truthful = `${spoken} OS3 is still working on another task. Ask again later.`;
  pendingElsewhere.steps[1].text = truthful;
  pendingElsewhere.steps[1].speakable_text = truthful;
  pendingElsewhere.steps[2].text = truthful;
  assert.equal(evaluate(pendingElsewhere).status, "pass");
});

for (const [description, canonical, text, expected] of [
  ["rejects a missing canonical speech field", undefined, "Battery is at 82%. LUMA-OS3-ROUND-A", "fail"],
  ["accepts a completed read alongside still-running work", "Battery is at 82%. monthly_report_final.csv; 2*3 + 4*5. LUMA-OS3-ROUND-A OS3 is still working on another task.", "Battery is at 82%. monthly_report_final.csv; 2*3 + 4*5. LUMA-OS3-ROUND-A OS3 is still working on another task.", "pass"],
]) {
  test(`OS3 result proof ${description}`, () => {
    const spec = selectAssistantCases("os3-task-result", "LUMA-OS3-ROUND-A")[1];
    const result = evaluateAssistantCase(spec, {
      steps: [
        { kind: "action", name: "ask_os3", input: "{}" },
        { kind: "observation", name: "ask_os3", text, speakable_text: canonical },
        { kind: "answer", name: "Respond", text },
      ],
      total_ms: 1_000, device_deadline_ms: 90_000,
    }, sample({ route: "d1", model_invoked: "false" }, 8), sample({ route: "d1", model_invoked: "false" }, 9));
    assert.equal(result.status, expected, result.failures.join(","));
    if (expected === "fail") assert.ok(result.failures.includes("answer_observation_mismatch:ask_os3"));
  });
}

test("an unavailable optional OS3 integration blocks without masking malformed status", () => {
  const spec = ASSISTANT_CASES.find(({ id }) => id === "os3-explicit-task");
  assert.equal(
    optionalToolBlock(spec, {
      tools: [{ name: "ask_os3", live: false, needs: "A successful OS3 Test in Center" }],
    }).ownerAction,
    "A successful OS3 Test in Center",
  );
  assert.equal(optionalToolBlock(spec, { tools: [] }), null);
  assert.equal(optionalToolBlock(spec, { tools: [{ name: "ask_os3", live: true, needs: "" }] }), null);
});

test("the semantic OS3 case is model-led and never leans on the os3 keyword", () => {
  const spec = selectAssistantCases("os3-semantic-mac")[0];
  assert.ok(spec, "the production matrix must exercise semantic OS3 delegation");
  // Keyword-independence is a property of the case itself: routing to OS3
  // must come from the model's tool choice, not from the utterance naming it.
  assert.doesNotMatch(spec.prompt, /os3/iu);
  assert.equal(spec.firstAction, "ask_os3");
  assert.deepEqual(spec.expectedActionInputs, { ask_os3: {} });
  assert.deepEqual(spec.exactActionSequence, ["ask_os3", "Respond"]);
  assert.equal(spec.answerEqualsObservation, "ask_os3");
  assert.equal(spec.route, "a1");
  assert.equal(spec.modelInvoked, undefined, "a1 cases require an invoked model");
  assert.equal(spec.simulateUnlockedPin, true);
  assert.equal(spec.authenticatedWearer, true);

  const modelLed = { route: "a1", model_invoked: "true" };
  const before = sample(modelLed, 2);
  const after = sample(modelLed, 3);
  const run = evaluateAssistantCase(
    spec,
    {
      steps: [
        { kind: "action", name: "ask_os3", input: "{}" },
        { kind: "observation", name: "ask_os3", text: "Two folders and a PDF.", speakable_text: "Two folders and a PDF." },
        { kind: "answer", name: "Respond", text: "Two folders and a PDF." },
      ],
      total_ms: 14_000,
      device_deadline_ms: 90_000,
    },
    before,
    after,
  );
  assert.equal(run.status, "pass", run.failures.join(","));
  assert.equal(run.run.modelInvoked, true);
  assert.equal(run.run.model, "gpt-5.6-sol");

  // A run that never invoked the model cannot pass a model-led case, and a
  // web-search detour for the same question fails the action list.
  const deterministic = { route: "a1", model_invoked: "false" };
  assert.ok(
    evaluateAssistantCase(spec, { steps: [], total_ms: 1, device_deadline_ms: 90_000 },
      sample(deterministic, 0), sample(deterministic, 1)).failures.includes("missing_model_run"),
  );
  const detour = evaluateAssistantCase(
    spec,
    {
      steps: [
        { kind: "action", name: "web_search", input: '{"query":"what is on my macbook"}' },
        { kind: "observation", name: "web_search", text: "Links." },
        { kind: "answer", name: "Respond", text: "Links." },
      ],
      total_ms: 9_000,
      device_deadline_ms: 90_000,
    },
    before,
    after,
  );
  assert.ok(detour.failures.includes("missing_action:ask_os3"));
  assert.ok(detour.failures.includes("first_action:ask_os3"));
  assert.ok(detour.failures.includes("forbidden_action:web_search"));
});

test("same-turn OS3 requires all exact result fields in its first canonical answer", () => {
  const cases = selectAssistantCases("os3-task-same-turn", "LUMA-OS3-SAME-A");
  assert.equal(cases.length, 1, "the isolated first-turn case must exist");
  const spec = cases[0];
  assert.equal(spec.os3SentinelRole, "same-turn");
  assert.equal(spec.dependsOn, undefined);
  assert.equal(spec.route, "d1");
  assert.equal(spec.modelInvoked, false);
  assert.equal(spec.answerPatterns.length, 4);
  const complete = "Battery is at 82%. monthly_report_final.csv; 2*3 + 4*5. LUMA-OS3-SAME-A";
  const labels = { route: "d1", model_invoked: "false", model_steps: "0" };
  const evaluate = (text, overrides = {}, canonical = text) => evaluateAssistantCase(spec, {
    steps: [
      { kind: "action", name: "ask_os3", input: "{}" },
      { kind: "observation", name: "ask_os3", text, speakable_text: canonical },
      { kind: "answer", name: "Respond", text },
    ], total_ms: 1_000, device_deadline_ms: 90_000,
  }, sample({ ...labels, ...overrides }, 1), sample({ ...labels, ...overrides }, 2));
  assert.equal(evaluate(complete).status, "pass");
  for (const bad of [
    "OS3 accepted your request.",
    "OS3 is still working on that.",
    complete.replace("82%", "battery unavailable"),
    complete.replace("monthly_report_final.csv", "monthlyreportfinal.csv"),
    complete.replace("2*3 + 4*5", "26"),
    complete.replace("2*3 + 4*5", "2*3 + 45"),
    complete.replace("LUMA-OS3-SAME-A", "LUMA-OS3-OLD-A"),
  ]) assert.ok(evaluate(bad).failures.includes("answer_mismatch"), bad);
  assert.ok(evaluate(complete, {}, `${complete} extra`).failures.includes("answer_observation_mismatch:ask_os3"));
  assert.equal(evaluate(complete, { route: "a1" }).status, "fail");
  assert.equal(evaluate(complete, { model_invoked: "true" }).status, "fail");
  assert.equal(evaluate(complete, { planner_plane: "pin_local" }).status, "fail");
});

test("same-turn OS3 selection uses the authoritative starter and fresh required marker per round", () => {
  const selected = selectAssistantCases("os3-task-same-turn", "LUMA-OS3-SAME-A");
  assert.equal(selected.length, 1);
  const next = selectAssistantCases("os3-task-same-turn", "LUMA-OS3-SAME-B")[0];
  const starter = selectAssistantCases("os3-explicit-task", "LUMA-OS3-SAME-A")[0];
  const result = selectAssistantCases("os3-task-result", "LUMA-OS3-SAME-A")[1];
  assert.equal(selected[0].prompt, starter.prompt);
  assert.deepEqual(selected[0].answerPatterns.map(String), result.answerPatterns.map(String));
  assert.match(next.prompt, /LUMA-OS3-SAME-B/u);
  assert.doesNotMatch(next.prompt, /LUMA-OS3-SAME-A/u);
  assert.equal(next.answerPatterns[0].test("LUMA-OS3-SAME-A"), false);
  assert.throws(() => selectAssistantCases("os3-task-same-turn"), /fresh bounded completion marker/u);
  const all = selectAssistantCases(undefined, "LUMA-OS3-SAME-A");
  const sameTurn = all.find(({ id }) => id === "os3-task-same-turn");
  const priorTask = all.find(({ id }) => id === "os3-explicit-task");
  assert.notEqual(sameTurn.prompt, priorTask.prompt, "separate tasks cannot share completion proof");
  assert.equal(sameTurn.answerPatterns[0].test("LUMA-OS3-SAME-A"), false);

});

test("selecting the OS3 result case also runs its starter first", () => {
  const first = selectAssistantCases("os3-task-result", "LUMA-OS3-ROUND.A");
  const second = selectAssistantCases("os3-task-result", "LUMA-OS3-ROUND-B");
  assert.deepEqual(first.map(({ id }) => id), ["os3-explicit-task", "os3-task-result"]);
  assert.deepEqual(
    selectAssistantCases("os3-explicit-task", "LUMA-OS3-ROUND.A").map(({ id }) => id),
    ["os3-explicit-task"],
  );
  assert.match(first[0].prompt, /LUMA-OS3-ROUND\.A/u);
  assert.equal(first[1].prompt, "What did OS3 find?");
  assert.doesNotMatch(first[1].prompt, /LUMA-OS3/u);
  assert.doesNotMatch(first[0].prompt, /LUMA-OS3-ROUND-B/u);
  assert.match(second[0].prompt, /LUMA-OS3-ROUND-B/u);
  assert.equal(second[1].prompt, "What did OS3 find?");
  assert.equal(first[1].answerPatterns.length, 4);
  assert.equal(
    first[1].answerPatterns.every((pattern) => pattern.test("Battery is 41%. monthly_report_final.csv; 2*3 + 4*5. LUMA-OS3-ROUND.A")),
    true,
  );
  assert.equal(
    first[1].answerPatterns.every((pattern) => pattern.test("LUMA-OS3-ROUND.A")),
    false,
  );
  assert.equal(
    first[1].answerPatterns.every((pattern) => pattern.test("Battery is 41%. monthly_report_final.csv; 2*3 + 4*5. LUMA-OS3-ROUNDXA")),
    false,
  );
  assert.equal(
    second[1].answerPatterns.every((pattern) => pattern.test("Battery 41 percent monthly_report_final.csv; 2*3 + 4*5. LUMA-OS3-ROUND-B")),
    true,
  );
  assert.throws(
    () => selectAssistantCases("os3-task-result"),
    /fresh bounded completion marker/u,
  );
});

// Synthetic unrecorded traces. This separate pair proves contextual routing,
// never converts the original strict read/result checks into pending passes.
test("contextual OS3 status selects its own starter and requires typed retained work", () => {
  const pair = selectAssistantCases("os3-contextual-status", "LUMA-OS3-CONTEXT-A");
  assert.deepEqual(pair.map(({ id }) => id), ["os3-contextual-task", "os3-contextual-status"]);
  const [starter, status] = pair;
  assert.match(starter.prompt, /LUMA-OS3-CONTEXT-A/u);
  assert.equal(status.prompt, "Any update?");
  assert.doesNotMatch(status.prompt, /LUMA-OS3/u);
  assert.equal(status.requiresRetainedOs3Task, starter.id);
  assert.equal(status.route, "d1");
  assert.equal(status.modelInvoked, false);
  assert.equal(status.answerEqualsObservation, "ask_os3");
  const all = selectAssistantCases(undefined, "LUMA-OS3-ROUND-A");
  const standalone = all.find(({ id }) => id === "os3-contextual-task");
  assert.doesNotMatch(standalone.prompt, /LUMA-OS3-ROUND-A/u, "independent contextual task cannot consume the strict pair");
});

test("contextual OS3 precondition blocks absent, false or malformed retained state", () => {
  const gate = evalModule.retainedOs3TaskBlock;
  assert.equal(typeof gate, "function", "typed retained-task preflight is required");
  const spec = { id: "os3-contextual-status", requiresRetainedOs3Task: "os3-contextual-task" };
  for (const starter of [undefined, {}, { os3_task_retained: false }, { os3_task_retained: "true" }]) {
    const result = gate(spec, starter);
    assert.equal(result.status, "blocked");
    assert.equal(result.precondition, "retained_os3_task_unavailable");
    assert.deepEqual(result.actions, []);
  }
  assert.equal(gate(spec, { os3_task_retained: true }), null);
  assert.equal(gate({ id: "os3-task-result" }, undefined), null, "strict historical case remains unchanged");
});

test("contextual status keeps pending proof distinct from a completed read", () => {
  const spec = selectAssistantCases("os3-contextual-status", "LUMA-OS3-CONTEXT-A")[1];
  assert.ok(spec, "contextual status case required");
  const labels = { route: "d1", model_invoked: "false" };
  const before = sample(labels, 2), after = sample(labels, 3);
  const traceFor = (text, retained) => ({
    steps: [
      { kind: "action", name: "ask_os3", input: "{}" },
      { kind: "observation", name: "ask_os3", text, speakable_text: text },
      { kind: "answer", name: "Respond", text },
    ],
    os3_task_retained: retained,
    total_ms: 10_000,
    device_deadline_ms: 90_000,
  });
  const pending = evaluateAssistantCase(spec, traceFor("OS3 is still working on that task.", true), before, after);
  assert.equal(pending.status, "pass");
  assert.equal(pending.proofScope, "contextual_status_only");
  const complete = "Battery is 82%. monthly_report_final.csv; 2*3 + 4*5. LUMA-OS3-CONTEXT-A";
  const result = evaluateAssistantCase(spec, traceFor(complete, false), before, after);
  assert.equal(result.status, "pass");
  assert.equal(result.proofScope, "completed_requested_read");
  assert.equal(evaluateAssistantCase(spec, traceFor("OS3 accepted your request.", false), before, after).status, "fail");
  assert.equal(evaluateAssistantCase(spec, traceFor(complete.replace("CONTEXT-A", "OLD-A"), false), before, after).status, "fail");
  const missing = traceFor(complete, undefined);
  assert.ok(evaluateAssistantCase(spec, missing, before, after).failures.includes("missing_os3_task_state"));
  const rewritten = traceFor("OS3 is still working.", true);
  rewritten.steps[2].text = "Done.";
  assert.ok(evaluateAssistantCase(spec, rewritten, before, after).failures.includes("answer_observation_mismatch:ask_os3"));
});

test("a confirming Yes carries its question's conversation and runs it first", () => {
  const [asked, confirmed] = selectAssistantCases("consequential-confirmation-yes");
  assert.equal(asked.id, "consequential-confirmation");
  assert.equal(confirmed.id, "consequential-confirmation-yes");
  assert.deepEqual(
    selectAssistantCases("consequential-confirmation").map(({ id }) => id),
    ["consequential-confirmation"],
  );

  // The question starts a Pin conversation. The Yes carries this round's
  // replay of it, and without one it fails instead of running alone.
  assert.deepEqual(assistantTracePayload(asked, caseReplay(asked, new Map())), {
    text: "Call Alex.",
    replay: "",
  });
  const replays = new Map([["consequential-confirmation", "Q2FsbCBBbGV4Pw=="]]);
  assert.deepEqual(assistantTracePayload(confirmed, caseReplay(confirmed, replays)), {
    text: "Yes.",
    simulate_unlocked_pin: true,
    replay: "Q2FsbCBBbGV4Pw==",
  });
  assert.equal(caseReplay(confirmed, new Map()), null);
  for (const spec of ASSISTANT_CASES) {
    if (spec === asked || spec === confirmed) continue;
    assert.equal(caseReplay(spec, replays), undefined, spec.id);
  }

  const placed = evaluateAssistantCase(
    confirmed,
    {
      steps: [{
        kind: "action",
        name: "CallPerson",
        source: "device",
        input: '{"To":["Alex"]}',
      }],
      total_ms: 4100,
      device_deadline_ms: 90000,
    },
    "",
    sample({ terminal: "device_action" }),
  );
  assert.equal(placed.status, "pass", placed.failures.join(","));

  // Asked again: the confirmation did not carry, so no call went out.
  const askedAgain = evaluateAssistantCase(
    confirmed,
    {
      steps: [{ kind: "answer", name: "Respond", text: "Call Alex?" }],
      total_ms: 3900,
      device_deadline_ms: 90000,
    },
    "",
    sample({ terminal: "confirmation_required" }),
  );
  assert.equal(askedAgain.status, "fail");
  assert.deepEqual(askedAgain.failures, [
    "missing_action:CallPerson",
    "forbidden_action:Respond",
    "action_count:CallPerson",
    "run_class:a1/confirmation_required",
  ]);
});

test("safe stock network setup cases carry unlocked Pin context", () => {
  for (const id of [
    "wifi-connect",
    "wifi-qr-scan",
    "cellular-data-on",
    "cellular-data-off",
    "cellular-roaming-off",
    "cellular-roaming-on-confirmation",
  ]) {
    const spec = ASSISTANT_CASES.find((candidate) => candidate.id === id);
    assert.deepEqual(assistantTracePayload(spec), {
      text: spec.prompt,
      simulate_unlocked_pin: true,
    });
  }

  const roaming = ASSISTANT_CASES.find(({ id }) => id === "cellular-roaming-on-confirmation");
  assert.deepEqual(roaming.requiredActions, ["Respond"]);
  assert.ok(roaming.forbiddenActions.includes("TurnOnCellularRoaming"));
  assert.equal(roaming.terminal, "confirmation_required");
});

test("direct music selection requires grounded catalog fields without rejecting safe extras", () => {
  const spec = ASSISTANT_CASES.find(({ id }) => id === "music-direct-track");
  const before = sample({ terminal: "device_action" }, 4);
  const after = sample({ terminal: "device_action" }, 5);
  const trace = {
    steps: [{
      kind: "action",
      name: "PlayMusic",
      input: JSON.stringify({ Artist: "Drake", Track: "One Dance", Option: "track" }),
    }],
    total_ms: 4_000,
    device_deadline_ms: 90_000,
  };

  const passing = evaluateAssistantCase(spec, trace, before, after);
  assert.equal(passing.status, "pass", passing.failures.join(","));

  trace.steps[0].input = JSON.stringify({ Artist: "Drake", Track: "Hotline Bling" });
  const wrongTrack = evaluateAssistantCase(spec, trace, before, after);
  assert.ok(wrongTrack.failures.includes("action_input_fields:PlayMusic"));
});

test("playlist playback puts the requested playlist in the stock Playlist slot", () => {
  const spec = ASSISTANT_CASES.find(({ id }) => id === "music-workout-playlist");
  assert.deepEqual(Object.keys(spec.expectedActionInputPatterns.PlayMusic), ["Playlist"]);
  const before = sample({ terminal: "device_action" }, 4);
  const after = sample({ terminal: "device_action" }, 5);
  const trace = {
    steps: [{ kind: "action", name: "PlayMusic", input: '{"Playlist":"sleep"}' }],
    total_ms: 4_000,
    device_deadline_ms: 90_000,
  };

  const wrongTopic = evaluateAssistantCase(spec, trace, before, after);
  assert.ok(wrongTopic.failures.includes("action_input_patterns:PlayMusic"));

  // A song search or a shuffle option cannot play the wearer's playlist.
  for (const misplaced of ['{"Track":"workout playlist"}', '{"Option":"workout playlist"}']) {
    trace.steps[0].input = misplaced;
    const failing = evaluateAssistantCase(spec, trace, before, after);
    assert.ok(failing.failures.includes("action_input_patterns:PlayMusic"), misplaced);
  }

  trace.steps[0].input = '{"Playlist":"workout"}';
  const passing = evaluateAssistantCase(spec, trace, before, after);
  assert.equal(passing.status, "pass", passing.failures.join(","));
});

test("a route case fails when every directions call failed", () => {
  const spec = ASSISTANT_CASES.find(({ id }) => id === "route-walking-nyhavn");
  const before = sample({}, 4);
  const after = sample({}, 5);
  const trace = (observation) => ({
    steps: [
      { kind: "action", name: "GetCurrentLocation", input: "{}" },
      { kind: "observation", name: "GetCurrentLocation", text: "55.6761, 12.5683" },
      {
        kind: "action",
        name: "route",
        input: '{"destination":"Nyhavn","mode":"walking"}',
      },
      { kind: "observation", name: "route", text: observation },
      { kind: "answer", name: "Respond", text: "Head north, then turn left onto Nyhavn." },
    ],
    total_ms: 6_000,
    device_deadline_ms: 90_000,
  });

  for (const failure of [
    "The directions backend could not be reached.",
    "No directions backend is connected in this deployment.",
    "The directions lookup returned no results.",
  ]) {
    const result = evaluateAssistantCase(spec, trace(failure), before, after);
    assert.ok(result.failures.includes("observation_mismatch:route"), failure);
  }

  const grounded = evaluateAssistantCase(
    spec,
    trace("Strandgade, 1.7 km, 23 mins. Directions: Head north on Vesterbrogade; Turn left onto Nyhavn"),
    before,
    after,
  );
  assert.equal(grounded.status, "pass", grounded.failures.join(","));
  assert.deepEqual(
    ASSISTANT_CASES.filter(({ requiredActions }) => requiredActions.includes("route"))
      .map(({ id, observationPatterns }) => [id, Boolean(observationPatterns?.route)]),
    [
      ["route-walking-nyhavn", true],
      ["route-driving-nyhavn", true],
      ["route-cycling-nyhavn", true],
      ["route-transit-nyhavn", true],
      ["nearest-coffee-route", true],
    ],
  );

  // A transit route is spoken one walk and one ride at a time.
  const transit = ASSISTANT_CASES.find(({ id }) => id === "route-transit-nyhavn");
  assert.deepEqual(transit.expectedActionInputs, {
    route: { destination: "Nyhavn", mode: "transit" },
  });
  const transitTrace = trace(
    "1.7 km, 12 mins. Directions: Walk to Rådhuspladsen St.; Take the M3 subway towards " +
      "Østerport St. from Rådhuspladsen St. at 2:05 PM, and get off at Kongens Nytorv St. " +
      "after 2 stops; Walk to the destination",
  );
  transitTrace.steps[2].input = '{"destination":"Nyhavn","mode":"transit"}';
  const ride = evaluateAssistantCase(transit, transitTrace, before, after);
  assert.equal(ride.status, "pass", ride.failures.join(","));
});

test("an explicit city forecast never acquires wearer location or simulates the privacy setting", () => {
  const spec = ASSISTANT_CASES.find(({ id }) => id === "weather-tomorrow-copenhagen");
  assert.ok(spec, "a named-city forecast case exists");
  assert.deepEqual(assistantTracePayload(spec), { text: "What will the weather be in Copenhagen tomorrow?" });
  const before = sample({}, 4);
  const after = sample({}, 5);
  const forecast = "Now: Clear. Daily forecast: today (Wednesday 30 September): Clear; tomorrow (Thursday 1 October): Rain.";
  const trace = {
    steps: [
      { kind: "action", name: "weather", input: '{"place":"Copenhagen"}' },
      { kind: "observation", name: "weather", text: forecast },
      { kind: "answer", name: "Respond", text: "Copenhagen has rain tomorrow." },
    ],
    total_ms: 6_000,
    device_deadline_ms: 90_000,
  };
  assert.equal(evaluateAssistantCase(spec, trace, before, after).status, "pass");
  const leakedLocation = evaluateAssistantCase(spec, {
    ...trace, steps: [{ kind: "action", name: "GetCurrentLocation", input: "{}" }, ...trace.steps],
  }, before, after);
  assert.ok(leakedLocation.failures.includes("forbidden_action:GetCurrentLocation"));
  const wrongPlace = evaluateAssistantCase(spec, {
    ...trace, steps: trace.steps.map((step) => step.name === "weather" && step.kind === "action"
      ? { ...step, input: '{"place":"London"}' } : step),
  }, before, after);
  assert.ok(wrongPlace.failures.includes("action_input_patterns:weather"));
  const noForecast = evaluateAssistantCase(spec, {
    ...trace, steps: trace.steps.map((step) => step.kind === "observation"
      ? { ...step, text: "Now: Clear." } : step),
  }, before, after);
  assert.ok(noForecast.failures.includes("observation_mismatch:weather"));
});

test("vision rule count is a read-only device route without camera or rule mutations", () => {
  const spec = ASSISTANT_CASES.find(({ id }) => id === "vision-action-count-read");
  for (const action of ["UnderstandScene", "AddIfThenEntry", "ClearIfThenMap"]) {
    assert.ok(spec.forbiddenActions.includes(action), action);
  }
  const before = sample({ route: "d1", model_invoked: "false", model_steps: "0", terminal: "device_action" }, 4);
  const after = sample({ route: "d1", model_invoked: "false", model_steps: "0", terminal: "device_action" }, 5);
  const trace = { steps: [{ kind: "action", name: "GetIfThenMapSize", input: "{}" }], total_ms: 20, device_deadline_ms: 90_000 };
  assert.equal(evaluateAssistantCase(spec, trace, before, after).status, "pass");
  for (const action of ["UnderstandScene", "AddIfThenEntry", "ClearIfThenMap"]) {
    const result = evaluateAssistantCase(spec, { ...trace, steps: [...trace.steps, { kind: "action", name: action, input: "{}" }] }, before, after);
    assert.ok(result.failures.includes(`forbidden_action:${action}`));
  }
});

test("a local forecast is answered from the weather forecast, not declined", () => {
  const spec = ASSISTANT_CASES.find(({ id }) => id === "weather-tomorrow-local");
  const before = sample({}, 4);
  const after = sample({}, 5);
  const trace = (observation, answer) => ({
    steps: [
      { kind: "action", name: "GetCurrentLocation", input: "{}" },
      { kind: "observation", name: "GetCurrentLocation", text: "55.6761, 12.5683" },
      { kind: "action", name: "weather", input: "{}" },
      { kind: "observation", name: "weather", text: observation },
      { kind: "answer", name: "Respond", text: answer },
    ],
    total_ms: 6_000,
    device_deadline_ms: 90_000,
  });
  const forecast =
    "Now: Clear, 61°F (16°C). Daily forecast: today (Thursday 24 September): Clear; " +
    "tomorrow (Friday 25 September): Light rain in the afternoon, high 59°F (15°C).";

  const answered = evaluateAssistantCase(
    spec,
    trace(forecast, "Tomorrow brings light rain in the afternoon, with a high of 15 degrees."),
    before,
    after,
  );
  assert.equal(answered.status, "pass", answered.failures.join(","));

  const declined = evaluateAssistantCase(
    spec,
    trace(forecast, "Future weather forecasts are not available yet."),
    before,
    after,
  );
  assert.ok(declined.failures.includes("answer_forbidden"));

  const currentOnly = evaluateAssistantCase(
    spec,
    trace("Clear, 61°F (16°C)", "Tomorrow it will be clear."),
    before,
    after,
  );
  assert.ok(currentOnly.failures.includes("observation_mismatch:weather"));
});

test("ranked playback evaluates as the configured wearer without exposing that identity", () => {
  const ranked = ASSISTANT_CASES.filter(({ providerGroundedMusic }) => providerGroundedMusic);
  assert.deepEqual(ranked.map(({ id }) => id), [
    "music-ranked-dr-dre-popular",
    "music-ranked-drake-popular",
    "music-ranked-drake-viral",
    "music-ranked-drake-controversial-2013",
    "music-ranked-michael-jackson-best",
  ]);
  for (const spec of ranked) {
    assert.equal(spec.simulateUnlockedPin, true);
    assert.deepEqual(spec.requiredActions, ["music_discover", "PlayMusic"]);
    assert.deepEqual(spec.requiredActionGroups, [["ask_online", "web_search"]]);
    assert.deepEqual(spec.exactActionCounts, { PlayMusic: 1 });
    assert.deepEqual(spec.allowedActionCounts, { music_discover: [1, 2] });
    assert.deepEqual(spec.exactActionGroupCounts, [{ actions: ["ask_online", "web_search"], count: 1 }]);
    assert.equal(spec.providerGroundedMusic, true);
    assert.equal(spec.route, "a2");
    assert.equal(spec.terminal, "device_action");
    assert.deepEqual(assistantTracePayload(spec), {
      text: spec.prompt,
      simulate_unlocked_pin: true,
    });
  }

  const invocation = assistantCurlCommand(
    ["--data-binary", "@-", "http://127.0.0.1:8080/demo-api/trace"],
    ranked[0],
  );
  assert.equal(invocation[0], "sh");
  assert.ok(invocation.includes("assistant-eval"));
  assert.match(invocation.join(" "), /COSMOS_ENROLLMENT_USER_ID/u);
  assert.doesNotMatch(invocation.join(" "), /owner-subject|local-wearer/u);
});

test("the configured wearer's edge proof reaches curl without entering argv", (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "luma-assistant-eval-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  // Stands in for curl: prints each argument, and the contents of a header file.
  fs.writeFileSync(path.join(bin, "curl"), [
    "#!/bin/sh",
    'for argument in "$@"; do',
    '  case "$argument" in',
    '    @/dev/fd/*) printf "file:%s\\n" "$(cat "${argument#@}")" ;;',
    '    *) printf "arg:%s\\n" "$argument" ;;',
    "  esac",
    "done",
    "",
  ].join("\n"), { mode: 0o755 });
  const spec = ASSISTANT_CASES.find(({ authenticatedWearer }) => authenticatedWearer);
  const invocation = assistantCurlCommand(["http://127.0.0.1:8080/demo-api/trace"], spec);
  const run = (environment) => spawnSync(invocation[0], invocation.slice(1), {
    env: { PATH: `${bin}:${process.env.PATH}`, ...environment },
    encoding: "utf8",
  });

  const proven = run({ COSMOS_ENROLLMENT_USER_ID: "wearer-1", COSMOS_EDGE_TOKEN: "edge-proof-value" });
  assert.equal(proven.status, 0, proven.stderr);
  assert.deepEqual(proven.stdout.trim().split("\n"), [
    "arg:--header",
    "arg:x-forwarded-client-cert: V:01:D:assistant-eval:U:wearer-1",
    "arg:--header",
    "file:x-cosmos-edge-token: edge-proof-value",
    "arg:http://127.0.0.1:8080/demo-api/trace",
  ]);
  assert.doesNotMatch(invocation.join(" "), /edge-proof-value/u);

  const unproven = run({ COSMOS_ENROLLMENT_USER_ID: "wearer-1" });
  assert.equal(unproven.status, 78);
  assert.equal(unproven.stdout, "");
  assert.match(unproven.stderr, /edge proof for the configured wearer is unavailable/u);
});

test("ranked playback requires one research tool and provider-grounded action data", () => {
  const spec = ASSISTANT_CASES.find(({ id }) => id === "music-ranked-drake-viral");
  const before = sample({ route: "a2", terminal: "device_action", model_steps: "3" }, 4);
  const after = sample({ route: "a2", terminal: "device_action", model_steps: "3" }, 5);
  const trace = {
    steps: [
      { kind: "action", name: "ask_online" },
      { kind: "observation", name: "ask_online", text: "One Dance by Drake." },
      { kind: "action", name: "music_discover" },
      {
        kind: "observation",
        name: "music_discover",
        text: JSON.stringify({
          status: "grounded",
          provider: "youtube_music",
          ranking_provenance: "not_ranked",
          discovery_provenance: "foreground_agent_web",
          track: { title: "One Dance", artist: "Drake" },
        }),
      },
      {
        kind: "action",
        name: "PlayMusic",
        input: JSON.stringify({ Track: "One Dance", Artist: "Drake" }),
      },
    ],
    total_ms: 14_000,
    device_deadline_ms: 90_000,
  };

  assert.equal(evaluateAssistantCase(spec, trace, before, after).status, "pass");

  const recoveredProviderMiss = structuredClone(trace);
  recoveredProviderMiss.steps.splice(
    2,
    0,
    {
      kind: "action",
      name: "music_discover",
      input: JSON.stringify({
        artist: "Drake",
        title: "Versace (Drake Remix)",
        criterion: "viral",
        timeframe: "all_time",
      }),
    },
    {
      kind: "observation",
      name: "music_discover",
      text: JSON.stringify({
        status: "provider_no_match",
        message: "A likely track was found, but it is not available on the active music provider.",
      }),
    },
  );
  assert.equal(
    evaluateAssistantCase(spec, recoveredProviderMiss, before, after).status,
    "pass",
  );

  const tooManyCandidates = structuredClone(recoveredProviderMiss);
  tooManyCandidates.steps.splice(4, 0, ...recoveredProviderMiss.steps.slice(2, 4));
  assert.ok(
    evaluateAssistantCase(spec, tooManyCandidates, before, after).failures.includes(
      "action_count:music_discover",
    ),
  );

  const noResearch = structuredClone(trace);
  noResearch.steps.splice(0, 2);
  assert.ok(
    evaluateAssistantCase(spec, noResearch, before, after).failures.includes(
      "missing_action_group:ask_online|web_search",
    ),
  );

  const ungrounded = structuredClone(trace);
  ungrounded.steps[3].text = JSON.stringify({ status: "unavailable" });
  assert.ok(
    evaluateAssistantCase(spec, ungrounded, before, after).failures.includes(
      "music_not_provider_grounded",
    ),
  );
});

test("ranked playback is blocked, not failed, while the owner must set up music", () => {
  const spec = ASSISTANT_CASES.find(({ id }) => id === "music-ranked-drake-popular");
  const message =
    "Music can't be looked up until your Pin is paired with Cosmos and a music provider " +
    "that plays on the Pin is chosen in Center under Settings, Services, Music.";
  const before = sample({ route: "a2", model_steps: "2" }, 4);
  const after = sample({ route: "a2", model_steps: "2" }, 5);
  const trace = (status = "provider_not_ready", spoken = message) => ({
    steps: [
      { kind: "action", name: "ask_online", input: '{"query":"Drake most popular song"}' },
      { kind: "observation", name: "ask_online", text: "One Dance by Drake." },
      {
        kind: "action",
        name: "music_discover",
        input: '{"artist":"Drake","title":"One Dance","criterion":"most popular"}',
      },
      { kind: "observation", name: "music_discover", text: JSON.stringify({ status, message }) },
      { kind: "answer", name: "Respond", text: spoken },
    ],
    total_ms: 9_000,
    device_deadline_ms: 90_000,
  });

  for (const status of ["provider_not_linked", "provider_not_ready", "provider_disabled"]) {
    const blocked = evaluateAssistantCase(spec, trace(status), before, after);
    assert.equal(blocked.status, "blocked", blocked.failures.join(","));
    assert.deepEqual(blocked.failures, []);
    assert.equal(blocked.ownerAction, message);
    assert.equal(blocked.run.terminal, "answered");
  }
  assert.equal(musicOwnerAction(trace().steps), message);

  // Every other shape is still a failure: a provider that answered but had
  // no match, a spoken answer that is not the owner action, extra research,
  // playback anyway, or an overrun Pin deadline.
  const failing = [
    trace("provider_no_match"),
    trace("unavailable"),
    trace("provider_not_ready", "Playing One Dance."),
  ];
  const twoLookups = trace();
  twoLookups.steps.splice(2, 0, { kind: "action", name: "web_search" });
  failing.push(twoLookups);
  const playedAnyway = trace();
  playedAnyway.steps.push({
    kind: "action",
    name: "PlayMusic",
    input: '{"Track":"One Dance","Artist":"Drake"}',
  });
  failing.push(playedAnyway);
  const late = trace();
  late.total_ms = 95_000;
  failing.push(late);
  for (const failed of failing) {
    const result = evaluateAssistantCase(spec, failed, before, after);
    assert.equal(result.status, "fail", JSON.stringify(failed.steps));
    assert.notDeepEqual(result.failures, []);
    // Linking a provider would not fix these, so no owner action is named.
    assert.equal(result.ownerAction, undefined, JSON.stringify(failed.steps));
  }

  // Only provider-grounded ranked playback can be blocked on setup. Stock
  // always sends ResumeMusic, so a spoken reply to "Resume the music." fails.
  const resume = evaluateAssistantCase(
    ASSISTANT_CASES.find(({ id }) => id === "music-resume"),
    {
      steps: [
        { kind: "observation", name: "music_discover", text: JSON.stringify({
          status: "provider_not_linked",
          message,
        }) },
        { kind: "answer", name: "Respond", text: message },
      ],
      total_ms: 1_400,
      device_deadline_ms: 90_000,
    },
    sample({}, 4),
    sample({}, 5),
  );
  assert.equal(resume.status, "fail");
  assert.equal(resume.ownerAction, undefined);
});

test("the report separates blocked cases and fails only on a failure", () => {
  const results = [
    { id: "reasoning", status: "pass", failures: [], totalMs: 900, run: null },
    {
      id: "music-ranked-drake-popular",
      status: "blocked",
      failures: [],
      ownerAction: "Your music provider isn't linked.",
      totalMs: 9_000,
      run: null,
    },
  ];
  const blockedOnly = assistantReport(results, 1);
  assert.deepEqual(
    [blockedOnly.schemaVersion, blockedOnly.passed, blockedOnly.blocked, blockedOnly.failed],
    [2, 1, 1, 0],
  );
  const text = renderReport(blockedOnly);
  assert.match(text, /^Cosmos assistant production evaluation: 1 passed, 1 blocked, 0 failed of 2$/mu);
  assert.match(text, /^BLOCKED music-ranked-drake-popular 9000ms no-run\/unknown$/mu);
  assert.match(text, /^  owner action: Your music provider isn't linked\.$/mu);

  const withFailure = assistantReport(
    [...results, { id: "music-resume", status: "fail", failures: ["missing_action:ResumeMusic"] }],
    1,
  );
  assert.equal(withFailure.failed, 1);
  assert.match(renderReport(withFailure), /^FAIL music-resume \?ms/mu);
});

test("evaluation names action, deadline, terminal, and provenance failures", () => {
  const result = evaluateAssistantCase(
    ASSISTANT_CASES.find(({ id }) => id === "compound-research"),
    {
      steps: [{ kind: "action", name: "web_search" }],
      total_ms: 26000,
      device_deadline_ms: 25000,
    },
    "",
    sample({ route: "a2", terminal: "deadline", model_provider: "unreported" }),
  );
  assert.deepEqual(result.failures, [
    "missing_action:wikipedia",
    "missing_action:Respond",
    "device_deadline",
    "run_class:a2/deadline",
    "missing_provenance:model_provider",
  ]);
  assert.equal(result.run.terminal, "deadline");
});

test("a recorded run of another class is named rather than reported missing", () => {
  const spec = ASSISTANT_CASES.find(({ id }) => id === "show-my-notes");
  const trace = {
    steps: [
      { kind: "action", name: "recall_memory", input: '{"query":""}' },
      { kind: "observation", name: "recall_memory", text: "The wearer has no saved notes." },
      { kind: "action", name: "recall_memory", input: '{"on_or_after":"0000-01-01","query":""}' },
      { kind: "observation", name: "recall_memory", text: "The wearer saved nothing in that time range." },
      { kind: "answer", name: "Respond", text: "You have no saved notes." },
    ],
    total_ms: 5_000,
    device_deadline_ms: 90_000,
  };
  // Cosmos records a run with more than one tool call as a2.
  const result = evaluateAssistantCase(
    spec,
    trace,
    sample({ route: "a2", model_steps: "3" }, 7),
    sample({ route: "a2", model_steps: "3" }, 8),
  );

  assert.deepEqual(result.failures, ["action_count:recall_memory", "run_class:a2/answered"]);
  assert.equal(result.run.route, "a2");

  const unrelated = evaluateAssistantCase(spec, trace, sample({}, 8), sample({}, 8));
  assert.ok(unrelated.failures.includes("missing_model_run"));
  assert.equal(unrelated.run, null);
});

test("a current product price cannot pass with only its historical launch price", () => {
  const result = evaluateAssistantCase(
    {
      id: "current-product-price",
      requiredActions: ["ask_online", "Respond"],
      forbiddenActions: [],
      route: "a1",
      terminal: "answered",
      answerPattern: /discontinued|no longer (?:sold|available)|not (?:currently )?(?:sold|available)/iu,
    },
    {
      steps: [
        { kind: "action", name: "ask_online" },
        {
          kind: "answer",
          name: "Respond",
          text: "The Humane AI Pin originally cost $699 plus a subscription.",
        },
      ],
      total_ms: 4200,
      device_deadline_ms: 25000,
    },
    sample({}, 4),
    sample({}, 5),
  );

  assert.equal(result.status, "fail");
  assert.ok(result.failures.includes("answer_mismatch"), result.failures.join(","));
});

test("a web-search refusal cannot pass merely because the tool ran", () => {
  const result = evaluateAssistantCase(
    ASSISTANT_CASES.find(({ id }) => id === "fresh-web-search"),
    {
      steps: [
        { kind: "action", name: "web_search" },
        {
          kind: "answer",
          name: "Respond",
          text: "I couldn’t find a reliable current Denmark news result.",
        },
      ],
      total_ms: 4200,
      device_deadline_ms: 25000,
    },
    sample({}, 4),
    sample({}, 5),
  );

  assert.equal(result.status, "fail");
  assert.ok(result.failures.includes("answer_forbidden"), result.failures.join(","));
});

test("the arithmetic acceptance accepts an equivalent spoken-number answer", () => {
  const spec = ASSISTANT_CASES.find(({ id }) => id === "arithmetic");
  const result = evaluateAssistantCase(
    spec,
    {
      steps: [{ kind: "answer", name: "Respond", text: "Twelve." }],
      total_ms: 4_000,
      device_deadline_ms: 90_000,
    },
    sample({}, 4),
    sample({}, 5),
  );

  assert.equal(result.status, "pass", result.failures.join(","));
});

test("a bounded lookup case cannot silently repeat the same provider tool", () => {
  const result = evaluateAssistantCase(
    {
      id: "nutrition-oatmeal",
      requiredActions: ["food_lookup", "Respond"],
      forbiddenActions: [],
      exactActionCounts: { food_lookup: 1 },
      route: "a1",
      terminal: "answered",
    },
    {
      steps: [
        { kind: "action", name: "food_lookup" },
        { kind: "action", name: "food_lookup" },
        { kind: "answer", name: "Respond", text: "Oatmeal has 68 calories per 100 grams." },
      ],
      total_ms: 4200,
      device_deadline_ms: 25000,
    },
    sample({}, 4),
    sample({}, 5),
  );

  assert.equal(result.status, "fail");
  assert.ok(result.failures.includes("action_count:food_lookup"), result.failures.join(","));
});

test("a prompt may explicitly accept either valid agent route without losing correlation", () => {
  const spec = {
    id: "weather-umbrella-local",
    requiredActions: ["GetCurrentLocation", "weather", "Respond"],
    forbiddenActions: [],
    exactActionCounts: { GetCurrentLocation: 1, weather: 1 },
    routes: ["a1", "a2"],
    terminal: "answered",
  };
  const result = evaluateAssistantCase(
    spec,
    {
      steps: [
        { kind: "action", name: "GetCurrentLocation" },
        { kind: "action", name: "weather" },
        { kind: "action", name: "ask_online" },
        { kind: "answer", name: "Respond", text: "Bring an umbrella just in case." },
      ],
      total_ms: 18_000,
      device_deadline_ms: 90_000,
    },
    sample({ route: "a2" }, 4),
    sample({ route: "a2" }, 5),
  );

  assert.equal(result.status, "pass", result.failures.join(","));
  assert.equal(result.run.route, "a2");
});

test("a safety case may accept either a spoken answer or a harmless device action", () => {
  const spec = ASSISTANT_CASES.find(({ id }) => id === "negative-volume-complaint");
  const result = evaluateAssistantCase(
    spec,
    {
      steps: [{ kind: "action", name: "DecrementVolume", input: "{}" }],
      total_ms: 4_000,
      device_deadline_ms: 90_000,
    },
    sample({ terminal: "device_action" }, 4),
    sample({ terminal: "device_action" }, 5),
  );

  assert.equal(result.status, "pass", result.failures.join(","));
  assert.equal(result.run.terminal, "device_action");
});

test("a loudness complaint fails when the volume moves the wrong way", () => {
  for (const [id, wrong, right] of [
    ["negative-volume-complaint", "IncrementVolume", "DecrementVolume"],
    ["volume-too-quiet-complaint", "DecrementVolume", "IncrementVolume"],
  ]) {
    const spec = ASSISTANT_CASES.find((candidate) => candidate.id === id);
    const run = (action) => evaluateAssistantCase(
      spec,
      {
        steps: [{ kind: "action", name: action, input: "{}" }],
        total_ms: 4_000,
        device_deadline_ms: 90_000,
      },
      sample({ terminal: "device_action" }, 4),
      sample({ terminal: "device_action" }, 5),
    );
    assert.ok(run(wrong).failures.includes(`forbidden_action:${wrong}`), id);
    assert.equal(run(right).status, "pass", id);
  }
});

test("the production matrix covers reasoning, retrieval, ambiguity, compound work, and confirmation", () => {
  assert.deepEqual(ASSISTANT_CASES.map(({ id }) => id), [
    "reasoning",
    "arithmetic",
    "unit-conversion",
    "ice-floats",
    "definition-ubiquitous",
    "knowledge-pride-austen",
    "knowledge-eiffel-height",
    "assistant-capabilities",
    "chitchat-joke",
    "music-direct-track",
    "music-direct-album",
    "music-workout-playlist",
    "music-featured",
    "music-favourites",
    "music-generate-running",
    "music-ranked-information",
    "music-ranked-dr-dre-information",
    "music-ranked-dr-dre-popular",
    "music-ranked-drake-popular",
    "music-ranked-drake-viral",
    "music-ranked-drake-controversial-2013",
    "music-ranked-michael-jackson-best",
    "fresh-web-search",
    "tour-de-france-current",
    "compound-research",
    "os3-explicit-task",
    "os3-task-result",
    "os3-task-same-turn",
    "os3-contextual-task",
    "os3-contextual-status",
    "os3-explicit-comma",
    "os3-semantic-mac",
    "explicit-lookup",
    "current-product-price",
    "nutrition-oatmeal",
    "show-my-notes",
    "weather-tomorrow-local",
    "show-timers",
    "show-alarms",
    "timer-set-five-minutes",
    "timer-pause",
    "timer-resume",
    "timer-add-one-minute",
    "timer-delete",
    "alarm-set-seven",
    "alarm-set-weekday",
    "alarm-cancel-seven",
    "alarm-cancel",
    "food-log-today",
    "food-calories-today",
    "food-log-three-days",
    "food-track-eggs",
    "food-track-banana",
    "reset-session",
    "messages-recent-read",
    "messages-contact-read",
    "messages-search-read",
    "messages-contact-topic-read",
    "messages-open-ui",
    "notifications-catch-up-read",
    "contacts-open-ui",
    "contacts-search-read",
    "contacts-phone-read",
    "contacts-quick-read",
    "dialer-open-ui",
    "dialpad-open-ui",
    "recent-calls-open-ui",
    "translation-good-morning-french",
    "translation-hello-spanish",
    "translation-hello-polish",
    "translation-thank-you-japanese",
    "recent-photos-open-ui",
    "music-queue-read",
    "vision-action-count-read",
    "route-walking-nyhavn",
    "route-driving-nyhavn",
    "route-cycling-nyhavn",
    "route-transit-nyhavn",
    "current-city-read",
    "weather-here",
    "weather-umbrella-local",
    "nearby-bare",
    "nearby-coffee",
    "nearest-coffee",
    "weather-copenhagen",
    "weather-capital-australia",
    "weather-tomorrow-copenhagen",
    "nearest-coffee-route",
    "weather-and-nearby",
    "volume-up-relative",
    "volume-up-plain",
    "volume-down-relative",
    "volume-set-30",
    "music-pause",
    "music-resume",
    "music-next",
    "music-previous",
    "music-restart",
    "music-save-current",
    "music-current-radio",
    "music-pause-semantic",
    "pin-current-time",
    "pin-battery-level",
    "pin-current-volume",
    "pin-online-status",
    "pin-device-status",
    "pin-bluetooth-status",
    "pin-airplane-status",
    "pin-phone-number",
    "pin-serial-number",
    "pin-current-location",
    "pin-nutrition-apple",
    "pin-nutrition-eggs",
    "pin-world-clock-tokyo",
    "ambiguous-no-vision",
    "music-control-hypothetical",
    "photo-how-to-negative",
    "messages-information-negative",
    "negative-volume-complaint",
    "volume-too-quiet-complaint",
    "tickle",
    "tickle-fancy",
    "tickle-triple",
    "wifi-off",
    "wifi-on",
    "wifi-connect",
    "wifi-qr-scan",
    "wifi-disconnect",
    "bluetooth-on",
    "bluetooth-off",
    "cellular-data-on",
    "cellular-data-off",
    "cellular-roaming-off",
    "cellular-roaming-on-confirmation",
    "tickle-near-miss",
    "consequential-confirmation",
    "consequential-confirmation-yes",
  ]);
  assert.equal(ASSISTANT_CASES.some(({ route }) => route === "a2"), true);
  assert.deepEqual(
    ASSISTANT_CASES.find(({ id }) => id === "messages-contact-read").expectedActionInputs,
    { DisplayMessages: { IDs: [], MessageCount: 10, Person: ["Alex"] } },
  );
  assert.deepEqual(
    ASSISTANT_CASES.find(({ id }) => id === "messages-contact-topic-read")
      .expectedActionInputs,
    { MessageSearch: { Person: ["Alex"], Query: "dinner" } },
  );
  assert.equal(
    ASSISTANT_CASES.some(({ forbiddenActions }) => forbiddenActions.includes("CallPerson")),
    true,
  );
  assert.equal(
    ASSISTANT_CASES.some(({ forbiddenActions }) => forbiddenActions.includes("UnderstandScene")),
    true,
  );
  const cycling = ASSISTANT_CASES.find(({ id }) => id === "route-cycling-nyhavn");
  assert.deepEqual(cycling.expectedActionInputs, {
    route: { destination: "Nyhavn", mode: "bicycling" },
  });
  assert.deepEqual(cycling.requiredActions, ["GetCurrentLocation", "route", "Respond"]);
  assert.deepEqual(cycling.exactActionCounts, { GetCurrentLocation: 1, route: 1 });
  assert.equal(cycling.simulateUnlockedPin, true);
  assert.equal(cycling.simulateLocation, true);
  assert.deepEqual(assistantTracePayload(cycling), {
    text: "Give me cycling directions to Nyhavn.",
    simulate_unlocked_pin: true,
    simulate_location: true,
  });
});

test("evaluation arguments are bounded and default to repeated runs", () => {
  const defaults = parseArguments([], { LUMA_ENV_FILE: "/tmp/runtime.env" });
  assert.equal(defaults.repeat, 2);
  assert.equal(defaults.caseId, null);
  assert.equal(defaults.projectName, "luma");
  assert.equal(parseArguments(["--repeat", "5"], { LUMA_ENV_FILE: "/tmp/e" }).repeat, 5);
  assert.equal(
    parseArguments(
      ["--case", "music-ranked-drake-viral"],
      { LUMA_ENV_FILE: "/tmp/e" },
    ).caseId,
    "music-ranked-drake-viral",
  );
  assert.throws(
    () => parseArguments(["--repeat", "6"], { LUMA_ENV_FILE: "/tmp/e" }),
    /1 through 5/u,
  );
  assert.throws(
    () => parseArguments(["--case", "not-a-case"], { LUMA_ENV_FILE: "/tmp/e" }),
    /unknown assistant evaluation case/u,
  );
});
