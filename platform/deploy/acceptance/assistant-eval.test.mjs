import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSISTANT_CASES,
  agentRunSamples,
  assistantCurlCommand,
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
  assert.equal(passing.pass, true, passing.failures.join(","));

  trace.steps[0].input = JSON.stringify({ Artist: "Drake", Track: "Hotline Bling" });
  const wrongTrack = evaluateAssistantCase(spec, trace, before, after);
  assert.ok(wrongTrack.failures.includes("action_input_fields:PlayMusic"));
});

test("playlist selection verifies the requested topic inside model-authored fields", () => {
  const base = ASSISTANT_CASES.find(({ id }) => id === "music-workout-playlist");
  const spec = {
    ...base,
    expectedActionInputPatterns: { PlayMusic: { Option: /\bworkout\b/iu } },
  };
  const before = sample({ terminal: "device_action" }, 4);
  const after = sample({ terminal: "device_action" }, 5);
  const trace = {
    steps: [{ kind: "action", name: "PlayMusic", input: '{"Option":"sleep playlist"}' }],
    total_ms: 4_000,
    device_deadline_ms: 90_000,
  };

  const wrongTopic = evaluateAssistantCase(spec, trace, before, after);
  assert.ok(wrongTopic.failures.includes("action_input_patterns:PlayMusic"));

  trace.steps[0].input = '{"Option":"my workout playlist"}';
  const passing = evaluateAssistantCase(spec, trace, before, after);
  assert.equal(passing.pass, true, passing.failures.join(","));
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

  assert.equal(evaluateAssistantCase(spec, trace, before, after).pass, true);

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
      text: "A likely track was found, but it is not available on the active music provider.",
    },
  );
  assert.equal(
    evaluateAssistantCase(spec, recoveredProviderMiss, before, after).pass,
    true,
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

  assert.equal(result.pass, true, result.failures.join(","));
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

  assert.equal(result.pass, true, result.failures.join(","));
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

  assert.equal(result.pass, true, result.failures.join(","));
  assert.equal(result.run.terminal, "device_action");
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
    "explicit-lookup",
    "current-product-price",
    "nutrition-oatmeal",
    "show-my-notes",
    "future-weather-limit",
    "transit-routing-limit",
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
    "translation-thank-you-japanese",
    "recent-photos-open-ui",
    "music-queue-read",
    "vision-action-count-read",
    "route-walking-nyhavn",
    "route-driving-nyhavn",
    "route-cycling-nyhavn",
    "current-city-read",
    "weather-here",
    "weather-umbrella-local",
    "nearby-bare",
    "nearby-coffee",
    "nearest-coffee",
    "weather-copenhagen",
    "weather-capital-australia",
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
  const defaults = parseArguments([], { REVIVAL_ENV_FILE: "/tmp/runtime.env" });
  assert.equal(defaults.repeat, 2);
  assert.equal(defaults.caseId, null);
  assert.equal(defaults.projectName, "ai-pin-revival");
  assert.equal(parseArguments(["--repeat", "5"], { REVIVAL_ENV_FILE: "/tmp/e" }).repeat, 5);
  assert.equal(
    parseArguments(
      ["--case", "music-ranked-drake-viral"],
      { REVIVAL_ENV_FILE: "/tmp/e" },
    ).caseId,
    "music-ranked-drake-viral",
  );
  assert.throws(
    () => parseArguments(["--repeat", "6"], { REVIVAL_ENV_FILE: "/tmp/e" }),
    /1 through 5/u,
  );
  assert.throws(
    () => parseArguments(["--case", "not-a-case"], { REVIVAL_ENV_FILE: "/tmp/e" }),
    /unknown assistant evaluation case/u,
  );
});
