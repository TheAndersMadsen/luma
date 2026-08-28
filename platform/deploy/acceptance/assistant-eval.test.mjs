import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSISTANT_CASES,
  agentRunSamples,
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
        { kind: "answer", name: "Respond" },
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
