import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSISTANT_CASES,
  agentRunSamples,
  assistantTracePayload,
  changedAgentRuns,
  evaluateAssistantCase,
  parseArguments,
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
  const spec = ASSISTANT_CASES[1];
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
  assert.equal(result.pass, true, result.failures.join(","));
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
  assert.equal(result.pass, false);
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

  assert.equal(result.pass, true, result.failures.join(","));
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
  assert.equal(passing.pass, true, passing.failures.join(","));

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

test("evaluation names action, deadline, terminal, and provenance failures", () => {
  const result = evaluateAssistantCase(
    ASSISTANT_CASES[2],
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
    "missing_model_run",
  ]);
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

  assert.equal(result.pass, false);
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

  assert.equal(result.pass, false);
  assert.ok(result.failures.includes("answer_forbidden"), result.failures.join(","));
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

  assert.equal(result.pass, false);
  assert.ok(result.failures.includes("action_count:food_lookup"), result.failures.join(","));
});

test("the production matrix covers reasoning, retrieval, ambiguity, compound work, and confirmation", () => {
  assert.deepEqual(ASSISTANT_CASES.map(({ id }) => id), [
    "reasoning",
    "fresh-web-search",
    "compound-research",
    "explicit-lookup",
    "current-product-price",
    "nutrition-oatmeal",
    "show-my-notes",
    "route-walking-nyhavn",
    "route-driving-nyhavn",
    "route-cycling-nyhavn",
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
    "tickle-near-miss",
    "consequential-confirmation",
  ]);
  assert.equal(ASSISTANT_CASES.some(({ route }) => route === "a2"), true);
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
  assert.equal(cycling.simulateUnlockedPin, true);
});

test("evaluation arguments are bounded and default to repeated runs", () => {
  const defaults = parseArguments([], { REVIVAL_ENV_FILE: "/tmp/runtime.env" });
  assert.equal(defaults.repeat, 2);
  assert.equal(defaults.projectName, "ai-pin-revival");
  assert.equal(parseArguments(["--repeat", "5"], { REVIVAL_ENV_FILE: "/tmp/e" }).repeat, 5);
  assert.throws(
    () => parseArguments(["--repeat", "6"], { REVIVAL_ENV_FILE: "/tmp/e" }),
    /1 through 5/u,
  );
});
