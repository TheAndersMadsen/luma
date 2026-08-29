import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CHECK_STATUS,
  SERVER_SOURCE,
  buildActionResponseFixture,
  decodeProtoFields,
  decodeUnderstandingRequest,
  decodeUnderstandingResponses,
  encodeUnderstandingRequest,
  parseGrpcFrames,
  wrapGrpcFrame,
} from "./agentic-release-smoke-lib.mjs";
import {
  FIXED_PROMPT_MATRIX,
  GLOBAL_EXCLUDED_TOOLS,
  HOLDOUT_SET_HASH,
  MATRIX_TIMEOUT_MS,
  MAX_MATRIX_CASES,
  OFFLINE_TIER_NAME,
  PROMPT_COMPARISON_UNAVAILABLE,
  REQUIRED_HOLDOUT_IDS,
  ROUTE_CLASS,
  classifyMatrixResponse,
  executeFixedPromptMatrix,
  main,
  parseMatrixCliArgs,
} from "./agentic-prompt-matrix.mjs";

const ACTION_IDENTIFIER = "00000000-0000-4000-8000-000000000001";
const GENERIC_NATIVE_ACTION_THOUGHT =
  "I should execute the one validated stock action selected after bounded read-only planning";
const GENERIC_FINAL_ANSWER_THOUGHT =
  "I should return the final answer from bounded read-only planning";
const RANK_ONE = Object.freeze({
  title: "PRIVATE_PROVIDER_TITLE_7f3a",
  artists: Object.freeze(["Michael Jackson"]),
  album: "PRIVATE_PROVIDER_ALBUM_7f3a",
});
const EXPECTED_IDENTITY = Object.freeze({
  releaseId: "fixture-release",
  packageName: "com.penumbraos.server",
  versionName: "2026-08-27.1",
  versionCode: 202_608_271,
  signerIdentity: "dd07f452",
});
const LIVE_ARGS = Object.freeze([
  "--serial", "device-123",
  "--expected-pin-serial", "device-123",
  "--release-manifest", "/fixture/manifest.json",
  "--release-receipts", "/fixture/receipts.json",
]);

function matrixCase(id) {
  const item = FIXED_PROMPT_MATRIX.find((candidate) => candidate.id === id);
  assert.ok(item, `missing matrix case ${id}`);
  return item;
}

function actionResponses({
  action,
  thought,
  input,
  parentIdentifier,
  identifier = ACTION_IDENTIFIER,
  source = SERVER_SOURCE,
  devicePayload = Buffer.alloc(0),
}) {
  return decodeUnderstandingResponses(
    parseGrpcFrames(
      wrapGrpcFrame(
        buildActionResponseFixture({
          action,
          thought,
          input,
          parentIdentifier,
          identifier,
          source,
          devicePayload,
        }),
      ),
    ),
  );
}

function expectedResponses(item, userTurnId, rankOne = RANK_ONE) {
  if (item.id === "deterministic_tickle_negative") return [];

  let thought = item.expectedThought;
  let input = "{}";
  if (item.id === "agentic_ice_explanation") {
    thought =
      "I should return the final answer from bounded read-only planning";
    input = JSON.stringify({
      Response:
        "Ice floats because its crystal structure makes it less dense than liquid water.",
    });
  } else if (item.id === "agentic_named_city_weather") {
    thought =
      "I should return the final answer from bounded read-only planning";
    input = JSON.stringify({
      Response:
        "The weather in Copenhagen is currently 16°C with mostly cloudy skies.",
    });
  } else if (item.id === "agentic_music_top_read") {
    thought =
      "I should return the final answer from bounded read-only planning";
    input = JSON.stringify({
      Response: `The top result for Michael Jackson is ${rankOne.title} by Michael Jackson.`,
    });
  } else if (
    item.id === "agentic_compound_navigation_preflight" ||
    item.id === "agentic_nearby_coffee_preflight" ||
    item.id === "agentic_city_location_preflight"
  ) {
    thought =
      "I should obtain the one authenticated device observation required by the read-only plan";
  } else if (
    item.id === "agentic_semantic_charge" ||
    item.id === "agentic_semantic_pause"
  ) {
    thought =
      "I should execute the one validated stock action selected after bounded read-only planning";
  } else if (item.id === "agentic_semantic_weather_preflight") {
    thought =
      "I should obtain the one authenticated device observation required by the read-only plan";
  } else if (item.id === "agentic_quoted_pause_negative") {
    thought =
      "I should return the final answer from bounded read-only planning";
    input = JSON.stringify({
      Response: "It would ask the active music experience to pause playback.",
    });
  } else if (item.id === "agentic_ranked_music") {
    thought =
      "I should execute the one validated stock action selected after bounded read-only planning";
    input = JSON.stringify({
      Track: rankOne.title,
      Artist: "Michael Jackson",
      Album: rankOne.album,
    });
  } else if (item.id === "agentic_dependent_capital_weather") {
    thought =
      "I should return the final answer from bounded read-only planning";
    input = JSON.stringify({
      Response:
        "The capital of Australia is Canberra. Canberra is currently 14°C with partly cloudy skies and light winds from the northwest.",
    });
  }

  return actionResponses({
    action: item.expectedActions[0],
    thought,
    input,
    parentIdentifier: userTurnId,
  });
}

test("Understand fixtures support a unique bounded parent and structural mutation exclusions", () => {
  const userTurnId = "matrix-case-01";
  const encoded = encodeUnderstandingRequest({
    utterance: "fixed public fixture",
    userTurnId,
    excludedTools: [...GLOBAL_EXCLUDED_TOOLS],
  });
  assert.deepEqual(
    decodeUnderstandingRequest(encoded, { expectedUserTurnId: userTurnId }),
    {
      utterance: "fixed public fixture",
      hasLocation: false,
      deviceContext: {
        isLocked: false,
        turns: [
          {
            user: 1,
            request: "fixed public fixture",
            identifier: userTurnId,
            parentIdentifier: "",
          },
        ],
      },
    },
  );
  const fields = decodeProtoFields(encoded);
  assert.deepEqual(
    fields.get(8).map((field) => field.value.toString("utf8")),
    ["CreateMemory", "SetVolume", "IncrementVolume", "DecrementVolume"],
  );
  assert.throws(
    () =>
      encodeUnderstandingRequest({
        utterance: "x",
        userTurnId: "turn;reboot",
      }),
    /user turn identifier/,
  );
});

test("the matrix is fixed, bounded, immutable, and the CLI accepts no prompt input", () => {
  assert.ok(FIXED_PROMPT_MATRIX.length > 12);
  assert.ok(FIXED_PROMPT_MATRIX.length <= MAX_MATRIX_CASES);
  assert.equal(Object.isFrozen(FIXED_PROMPT_MATRIX), true);
  assert.ok(FIXED_PROMPT_MATRIX.every(Object.isFrozen));
  assert.equal(new Set(FIXED_PROMPT_MATRIX.map((item) => item.id)).size, FIXED_PROMPT_MATRIX.length);
  assert.ok(
    FIXED_PROMPT_MATRIX.every(
      (item) => Buffer.byteLength(item.prompt) <= 512 && !item.prompt.includes("\0"),
    ),
  );
  assert.ok(
    FIXED_PROMPT_MATRIX.every(
      (item) =>
        !item.expectedActions.some((action) =>
          ["SetVolume", "IncrementVolume", "DecrementVolume"].includes(action),
        ),
    ),
  );

  assert.deepEqual(parseMatrixCliArgs([...LIVE_ARGS, "--json"]), {
    serial: "device-123",
    expectedPinSerial: "device-123",
    adbPath: "adb",
    releaseManifestPath: "/fixture/manifest.json",
    releaseReceiptsPath: "/fixture/receipts.json",
    json: true,
    help: false,
  });
  assert.throws(() => parseMatrixCliArgs([]), /explicit ADB serial/);
  assert.throws(
    () => parseMatrixCliArgs(["--serial", "device-123"]),
    /expected AI Pin serial/,
  );
  assert.throws(
    () =>
      parseMatrixCliArgs([
        ...LIVE_ARGS.slice(0, 3),
        "other-device",
        ...LIVE_ARGS.slice(4),
      ]),
    /does not match/,
  );
  assert.throws(
    () => parseMatrixCliArgs(["--serial", "device", "--prompt", "hello"]),
    /unknown command option/,
  );
});

test("safe checklist wording is represented by exact prompt-shaped contracts", () => {
  const expected = new Map([
    [
      "agentic_ice_explanation",
      ["Explain why ice floats on water in one sentence.", "Respond"],
    ],
    [
      "agentic_named_city_weather",
      ["What is the weather in Copenhagen right now?", "Respond"],
    ],
    [
      "agentic_city_location_preflight",
      ["What city am I in?", "GetCurrentLocation"],
    ],
    [
      "agentic_nearby_coffee_preflight",
      ["Find coffee shops nearby.", "GetCurrentLocation"],
    ],
    [
      "agentic_quoted_pause_negative",
      ["What happens if I say 'pause the music'?", "Respond"],
    ],
    [
      "deterministic_weather_preflight",
      ["What's the weather here?", "GetCurrentLocation"],
    ],
  ]);

  for (const [id, [prompt, action]] of expected) {
    const item = matrixCase(id);
    assert.equal(item.prompt, prompt, id);
    assert.deepEqual(item.expectedActions, [action], id);
  }
});

test("generic final-answer classification validates semantics without exposing private content", () => {
  const item = matrixCase("agentic_ice_explanation");
  const userTurnId = "matrix-private-turn";
  const privateResponse =
    "PRIVATE_RESPONSE_91ab: Ice is less dense than liquid water because of its crystal structure.";
  const result = classifyMatrixResponse(
    item,
    actionResponses({
      action: "Respond",
      thought:
        "I should return the final answer from bounded read-only planning",
      input: JSON.stringify({ Response: privateResponse }),
      parentIdentifier: userTurnId,
    }),
    { userTurnId, elapsedMs: 4_000 },
  );

  assert.equal(result.status, "pass");
  assert.equal(result.routeClass, ROUTE_CLASS.AGENTIC_FINAL_ANSWER);
  assert.equal(result.actionName, "Respond");
  assert.equal(result.latencyBucket, "under_5s");
  assert.ok(Object.values(result.structure).every(Boolean));
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /PRIVATE_RESPONSE|less dense|bounded read-only|matrix-private-turn/);
  assert.doesNotMatch(serialized, /"(?:prompt|utterance|thought|input|response|runId|userTurnId)"/);
});

test("provider-backed cases disclose only a match boolean", () => {
  const item = matrixCase("agentic_ranked_music");
  const userTurnId = "matrix-provider-turn";
  const responses = expectedResponses(item, userTurnId);
  const matched = classifyMatrixResponse(item, responses, {
    userTurnId,
    elapsedMs: 7_000,
    rankOne: RANK_ONE,
  });
  assert.equal(matched.status, "pass");
  assert.equal(matched.providerMatch, true);
  assert.equal(matched.routeClass, ROUTE_CLASS.AGENTIC_NATIVE_ACTION);
  assert.doesNotMatch(JSON.stringify(matched), /PRIVATE_PROVIDER|Michael Jackson/);

  const mismatched = classifyMatrixResponse(item, responses, {
    userTurnId,
    elapsedMs: 7_000,
    rankOne: { ...RANK_ONE, title: "DIFFERENT_PRIVATE_TITLE" },
  });
  assert.equal(mismatched.status, "fail");
  assert.equal(mismatched.providerMatch, false);
});

test("top-track read accepts grounded provider paraphrases but rejects partial or embedded matches", () => {
  const item = matrixCase("agentic_music_top_read");
  const userTurnId = "matrix-provider-answer-turn";
  const classify = (response, rankOne = RANK_ONE) =>
    classifyMatrixResponse(
      item,
      actionResponses({
        action: "Respond",
        thought:
          "I should return the final answer from bounded read-only planning",
        input: JSON.stringify({ Response: response }),
        parentIdentifier: userTurnId,
      }),
      { userTurnId, elapsedMs: 4_000, rankOne },
    );

  assert.equal(
    classify(
      `According to the music provider, ${RANK_ONE.title} by ${RANK_ONE.artists[0]} is ranked first.`,
    ).status,
    "pass",
  );
  assert.equal(
    classify(`The top result is ${RANK_ONE.title} by a different artist.`).status,
    "fail",
  );
  assert.equal(
    classify(`The top result for ${RANK_ONE.artists[0]} is a different track.`).status,
    "fail",
  );
  assert.equal(
    classify(
      `The provider returned x${RANK_ONE.title}x by x${RANK_ONE.artists[0]}x.`,
    ).status,
    "fail",
  );
});

test("compound nearby navigation expects the agentic location preflight", () => {
  const item = matrixCase("agentic_compound_navigation_preflight");
  const userTurnId = "matrix-nearby-route-turn";
  const result = classifyMatrixResponse(
    item,
    expectedResponses(item, userTurnId),
    { userTurnId, elapsedMs: 4_000 },
  );

  assert.equal(result.status, "pass");
  assert.equal(result.routeClass, ROUTE_CLASS.AGENTIC_LOCATION_PREFLIGHT);
  assert.equal(result.actionName, "GetCurrentLocation");
  assert.ok(Object.values(result.structure).every(Boolean));
});

test("dependent capital weather resolves through model-selected knowledge without native dispatch", () => {
  const item = matrixCase("agentic_dependent_capital_weather");
  const userTurnId = "matrix-dependent-capital-turn";
  const result = classifyMatrixResponse(
    item,
    expectedResponses(item, userTurnId),
    { userTurnId, elapsedMs: 4_000 },
  );

  assert.equal(result.status, "pass");
  assert.equal(result.routeClass, ROUTE_CLASS.AGENTIC_FINAL_ANSWER);
  assert.equal(result.actionName, "Respond");
  assert.ok(Object.values(result.structure).every(Boolean));
});

test("dependent capital weather rejects missing or wrong country, same-name locality, native escape, premature terminal, redundant retry, and weather after rejected place", () => {
  const item = matrixCase("agentic_dependent_capital_weather");
  const classify = (responses, userTurnId) =>
    classifyMatrixResponse(item, responses, {
      userTurnId,
      elapsedMs: 4_000,
    });

  const missingCountry = classify(
    actionResponses({
      action: "Respond",
      thought:
        "I should return the final answer from bounded read-only planning",
      input: JSON.stringify({
        Response: "Canberra is currently 14°C with partly cloudy skies.",
      }),
      parentIdentifier: "matrix-dependent-missing-country",
    }),
    "matrix-dependent-missing-country",
  );
  assert.equal(missingCountry.status, "fail");
  assert.equal(missingCountry.routeClass, ROUTE_CLASS.AGENTIC_FINAL_ANSWER);

  const wrongCountry = classify(
    actionResponses({
      action: "Respond",
      thought:
        "I should return the final answer from bounded read-only planning",
      input: JSON.stringify({
        Response:
          "Canberra, New Zealand is currently 14°C with partly cloudy skies.",
      }),
      parentIdentifier: "matrix-dependent-wrong-country",
    }),
    "matrix-dependent-wrong-country",
  );
  assert.equal(wrongCountry.status, "fail");
  assert.equal(wrongCountry.routeClass, ROUTE_CLASS.AGENTIC_FINAL_ANSWER);

  const sameNameWrongLocality = classify(
    actionResponses({
      action: "Respond",
      thought:
        "I should return the final answer from bounded read-only planning",
      input: JSON.stringify({
        Response:
          "Sydney, Australia is currently 22°C with clear sunny skies.",
      }),
      parentIdentifier: "matrix-dependent-same-name-wrong",
    }),
    "matrix-dependent-same-name-wrong",
  );
  assert.equal(sameNameWrongLocality.status, "fail");
  assert.equal(
    sameNameWrongLocality.routeClass,
    ROUTE_CLASS.AGENTIC_FINAL_ANSWER,
  );

  const locationEscape = classify(
    actionResponses({
      action: "GetCurrentLocation",
      thought:
        "I should obtain the one authenticated device observation required by the read-only plan",
      input: "{}",
      parentIdentifier: "matrix-dependent-location-escape",
    }),
    "matrix-dependent-location-escape",
  );
  assert.equal(locationEscape.status, "fail");
  assert.equal(locationEscape.actionName, "GetCurrentLocation");

  const weatherEscape = classify(
    actionResponses({
      action: "GetWeather",
      thought:
        "I should execute the one validated stock action selected after bounded read-only planning",
      input: "{}",
      parentIdentifier: "matrix-dependent-weather-escape",
    }),
    "matrix-dependent-weather-escape",
  );
  assert.equal(weatherEscape.status, "fail");
  assert.equal(weatherEscape.actionName, "GetWeather");

  const prematureTerminal = classify(
    actionResponses({
      action: "Respond",
      thought:
        "I should return the final answer from bounded read-only planning",
      input: JSON.stringify({
        Response: "The capital of Australia is Canberra.",
      }),
      parentIdentifier: "matrix-dependent-premature-terminal",
    }),
    "matrix-dependent-premature-terminal",
  );
  assert.equal(prematureTerminal.status, "fail");
  assert.equal(prematureTerminal.routeClass, ROUTE_CLASS.AGENTIC_FINAL_ANSWER);

  const redundantRetryAfterValidPlace = classify(
    actionResponses({
      action: "Respond",
      thought:
        "I should return the final answer from bounded read-only planning",
      input: JSON.stringify({
        Response:
          "I identified Canberra as the capital of Australia. Let me look that up again to confirm the current conditions.",
      }),
      parentIdentifier: "matrix-dependent-redundant-retry",
    }),
    "matrix-dependent-redundant-retry",
  );
  assert.equal(redundantRetryAfterValidPlace.status, "fail");
  assert.equal(
    redundantRetryAfterValidPlace.routeClass,
    ROUTE_CLASS.AGENTIC_FINAL_ANSWER,
  );

  const weatherAfterRejectedPlace = classify(
    actionResponses({
      action: "Respond",
      thought:
        "I should return the final answer from bounded read-only planning",
      input: JSON.stringify({
        Response:
          "The capital city lookup was inconclusive. Melbourne, Australia is currently 16°C with overcast skies and light rain.",
      }),
      parentIdentifier: "matrix-dependent-rejected-place",
    }),
    "matrix-dependent-rejected-place",
  );
  assert.equal(weatherAfterRejectedPlace.status, "fail");
  assert.equal(
    weatherAfterRejectedPlace.routeClass,
    ROUTE_CLASS.AGENTIC_FINAL_ANSWER,
  );

  const safeFailure = classify(
    actionResponses({
      action: "Respond",
      thought:
        "A selected read-only information service failed before returning a result",
      input: JSON.stringify({
        Response:
          "I could not resolve the weather for that location right now.",
      }),
      parentIdentifier: "matrix-dependent-safe-failure",
    }),
    "matrix-dependent-safe-failure",
  );
  assert.equal(safeFailure.status, "fail");
});

test("paired exact controls and unseen paraphrases distinguish deterministic and agentic native routes", () => {
  const pairs = [
    [
      "agentic_semantic_charge",
      "deterministic_battery_level",
      "GetBatteryLevel",
      "Tell me the battery percentage remaining right now.",
    ],
    [
      "agentic_semantic_pause",
      "deterministic_pause_music",
      "PauseMusic",
      "Pause playback for now.",
    ],
  ];

  for (const [fallbackId, controlId, actionName, holdoutPrompt] of pairs) {
    const fallback = matrixCase(fallbackId);
    const control = matrixCase(controlId);
    assert.equal(fallback.modelFallbackControlId, controlId);
    assert.equal(fallback.prompt, holdoutPrompt);
    assert.notEqual(fallback.prompt, control.prompt);
    assert.deepEqual(fallback.expectedActions, control.expectedActions);

    const controlTurnId = `matrix-${controlId}-wording-independent`;
    const deterministic = classifyMatrixResponse(
      control,
      actionResponses({
        action: actionName,
        thought: "A stock-local parser selected this fieldless native action",
        input: "{}",
        parentIdentifier: controlTurnId,
      }),
      { userTurnId: controlTurnId, elapsedMs: 1_000 },
    );
    assert.equal(deterministic.status, "pass", controlId);
    assert.equal(
      deterministic.routeClass,
      ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION,
      controlId,
    );

    const modelOnControlTurnId = `matrix-${controlId}-agentic-escape`;
    const modelOnControl = classifyMatrixResponse(
      control,
      actionResponses({
        action: actionName,
        thought: GENERIC_NATIVE_ACTION_THOUGHT,
        input: "{}",
        parentIdentifier: modelOnControlTurnId,
      }),
      { userTurnId: modelOnControlTurnId, elapsedMs: 4_000 },
    );
    assert.equal(modelOnControl.status, "fail", controlId);
    assert.equal(
      modelOnControl.routeClass,
      ROUTE_CLASS.AGENTIC_NATIVE_ACTION,
      controlId,
    );

    const fallbackTurnId = `matrix-${fallbackId}-agentic`;
    const agentic = classifyMatrixResponse(
      fallback,
      expectedResponses(fallback, fallbackTurnId),
      { userTurnId: fallbackTurnId, elapsedMs: 4_000 },
    );
    assert.equal(agentic.status, "pass", fallbackId);
    assert.equal(
      agentic.routeClass,
      ROUTE_CLASS.AGENTIC_NATIVE_ACTION,
      fallbackId,
    );

    const unprovenTurnId = `matrix-${fallbackId}-unproven`;
    const unproven = classifyMatrixResponse(
      fallback,
      actionResponses({
        action: actionName,
        thought: "A stock-local parser selected this fieldless native action",
        input: "{}",
        parentIdentifier: unprovenTurnId,
      }),
      { userTurnId: unprovenTurnId, elapsedMs: 1_000 },
    );
    assert.equal(unproven.status, "fail", fallbackId);
    assert.equal(unproven.routeClass, ROUTE_CLASS.UNKNOWN, fallbackId);
  }
});

test("model-fallback holdouts are not exact phrases in their deterministic parsers", () => {
  const cases = [
    [
      "agentic_semantic_charge",
      "deterministic_battery_level",
      new URL(
        "../../../../pin/runtime/core/src/synapse/native_device_actions.rs",
        import.meta.url,
      ),
    ],
    [
      "agentic_semantic_pause",
      "deterministic_pause_music",
      new URL(
        "../../../../pin/runtime/core/src/synapse/capabilities/music.rs",
        import.meta.url,
      ),
    ],
  ];

  for (const [fallbackId, controlId, sourceUrl] of cases) {
    const fallback = matrixCase(fallbackId);
    const control = matrixCase(controlId);
    const source = readFileSync(sourceUrl, "utf8").toLocaleLowerCase("en-US");
    const normalizedFallback = fallback.prompt
      .toLocaleLowerCase("en-US")
      .replaceAll(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");

    assert.ok(source.includes(`"${control.prompt}"`), controlId);
    assert.equal(
      source.includes(`"${normalizedFallback}"`),
      false,
      fallbackId,
    );
  }
});

test("semantic weather and quoted-action controls still require exact agentic routes", () => {
  const expectations = [
    [
      "agentic_semantic_weather_preflight",
      ROUTE_CLASS.AGENTIC_LOCATION_PREFLIGHT,
      "GetCurrentLocation",
    ],
    ["agentic_quoted_pause_negative", ROUTE_CLASS.AGENTIC_FINAL_ANSWER, "Respond"],
  ];
  for (const [id, routeClass, actionName] of expectations) {
    const item = matrixCase(id);
    const userTurnId = `matrix-${id}`;
    const result = classifyMatrixResponse(
      item,
      expectedResponses(item, userTurnId),
      { userTurnId, elapsedMs: 4_000 },
    );
    assert.equal(result.status, "pass", id);
    assert.equal(result.routeClass, routeClass, id);
    assert.equal(result.actionName, actionName, id);
  }

  const quoted = matrixCase("agentic_quoted_pause_negative");
  const escaped = classifyMatrixResponse(
    quoted,
    actionResponses({
      action: "PauseMusic",
      thought:
        "I should execute the one validated stock action selected after bounded read-only planning",
      input: "{}",
      parentIdentifier: "matrix-quoted-escape",
    }),
    { userTurnId: "matrix-quoted-escape", elapsedMs: 4_000 },
  );
  assert.equal(escaped.status, "fail");
  assert.equal(escaped.actionName, "PauseMusic");
});

test("the non-exact Tickle control accepts no action and rejects a Tickle action", () => {
  const item = matrixCase("deterministic_tickle_negative");
  const userTurnId = "matrix-negative-turn";
  const noAction = classifyMatrixResponse(item, [], {
    userTurnId,
    elapsedMs: 1_000,
  });
  assert.equal(noAction.status, "pass");
  assert.equal(noAction.routeClass, ROUTE_CLASS.NO_ACTION);
  assert.equal(noAction.actionName, null);

  const escaped = classifyMatrixResponse(
    item,
    actionResponses({
      action: "Tickle",
      thought:
        "The user invoked the enabled stock Tickle prototype with an exact local phrase",
      input: "{}",
      parentIdentifier: userTurnId,
    }),
    { userTurnId, elapsedMs: 1_000 },
  );
  assert.equal(escaped.status, "fail");
  assert.equal(escaped.actionName, "Tickle");
});

test("the non-exact Tickle control accepts every structured Respond route and rejects every non-Respond action", () => {
  const item = matrixCase("deterministic_tickle_negative");
  const safeFailureThoughts = [
    "The semantic model was unavailable before it could finish the request",
    "A selected read-only information service failed before returning a result",
    "A selected read-only information service returned an invalid result",
    "The semantic loop reached its repetition or runaway circuit breaker",
    "The required device observation could not be verified",
    "The semantic runtime configuration was invalid",
    "The semantic request or model operation did not match the validated protocol",
  ];

  for (const [index, thought] of safeFailureThoughts.entries()) {
    const userTurnId = `matrix-negative-safe-failure-${index}`;
    const result = classifyMatrixResponse(
      item,
      actionResponses({
        action: "Respond",
        thought,
        input: JSON.stringify({ Response: "Please use one of the exact launcher phrases." }),
        parentIdentifier: userTurnId,
      }),
      { userTurnId, elapsedMs: 1_000 },
    );
    assert.equal(result.status, "pass", thought);
    assert.equal(result.routeClass, ROUTE_CLASS.AGENTIC_SAFE_FAILURE, thought);
  }

  const unknownTurnId = "matrix-negative-unknown-respond";
  const unknownRespond = classifyMatrixResponse(
    item,
    actionResponses({
      action: "Respond",
      thought: "A future truthful non-action response route",
      input: JSON.stringify({ Response: "That is not a Tickle launcher phrase." }),
      parentIdentifier: unknownTurnId,
    }),
    { userTurnId: unknownTurnId, elapsedMs: 1_000 },
  );
  assert.equal(unknownRespond.status, "pass");
  assert.equal(unknownRespond.routeClass, ROUTE_CLASS.UNKNOWN);

  for (const action of [
    "Tickle",
    "GetBatteryLevel",
    "GetCurrentLocation",
    "CapturePhotograph",
    "FutureNativeAction",
  ]) {
    const userTurnId = `matrix-negative-action-${action}`;
    const escaped = classifyMatrixResponse(
      item,
      actionResponses({
        action,
        thought: "A future native action route",
        input: "{}",
        parentIdentifier: userTurnId,
      }),
      { userTurnId, elapsedMs: 1_000 },
    );
    assert.equal(escaped.status, "fail", action);
  }

  const malformedTurnId = "matrix-negative-malformed-respond";
  const malformed = classifyMatrixResponse(
    item,
    actionResponses({
      action: "Respond",
      thought: "A future truthful non-action response route",
      input: JSON.stringify({ Wrong: "not a stock Respond payload" }),
      parentIdentifier: malformedTurnId,
    }),
    { userTurnId: malformedTurnId, elapsedMs: 1_000 },
  );
  assert.equal(malformed.status, "fail");
});

test("the fixed runner is sequential, uses exact safety options, and emits no raw data", async () => {
  let active = 0;
  let maximumActive = 0;
  const calls = [];
  let clock = 0;
  const report = await executeFixedPromptMatrix({
    options: { serial: "device-123", adbPath: "adb" },
    grpcPort: 9_090,
    rankOne: RANK_ONE,
    runtime: {
      makeUserTurnId: (_id, index) => `matrix-turn-${index}`,
      now: () => {
        clock += 100;
        return clock;
      },
      runUnderstand: async (options, port, prompt, probeOptions) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        calls.push({ options, port, prompt, probeOptions });
        const item = FIXED_PROMPT_MATRIX.find(
          (candidate) => candidate.prompt === prompt,
        );
        const responses = expectedResponses(
          item,
          probeOptions.userTurnId,
          RANK_ONE,
        );
        active -= 1;
        return responses;
      },
    },
  });

  assert.equal(maximumActive, 1);
  assert.equal(calls.length, FIXED_PROMPT_MATRIX.length);
  assert.equal(report.summary.pass, FIXED_PROMPT_MATRIX.length);
  assert.equal(report.summary.fail, 0);
  assert.equal(new Set(calls.map((call) => call.probeOptions.userTurnId)).size, calls.length);
  for (const call of calls) {
    assert.equal(call.port, 9_090);
    assert.equal(call.probeOptions.timeoutMs, MATRIX_TIMEOUT_MS);
    assert.deepEqual(call.probeOptions.excludedTools, [
      "CreateMemory",
      "SetVolume",
      "IncrementVolume",
      "DecrementVolume",
    ]);
  }

  const serialized = JSON.stringify(report);
  for (const item of FIXED_PROMPT_MATRIX.filter(
    (candidate) => candidate.prompt.length > 30,
  )) {
    assert.equal(serialized.includes(item.prompt), false, item.id);
  }
  assert.doesNotMatch(serialized, /PRIVATE_PROVIDER|bounded read-only planning|matrix-turn-/);
  assert.doesNotMatch(serialized, /"(?:prompt|utterance|thought|input|response|runId|userTurnId)"/);
  assert.equal(report.safety.nativeActionsDispatched, false);
  assert.equal(report.safety.volumeMutationsExcluded, true);
  assert.equal(report.safety.concurrency, 1);
});

test("two consecutive infrastructure failures stop all further probes", async () => {
  let calls = 0;
  const report = await executeFixedPromptMatrix({
    options: { serial: "device-123", adbPath: "adb" },
    grpcPort: 9_090,
    runtime: {
      makeUserTurnId: (_id, index) => `matrix-failure-${index}`,
      now: () => 1_000,
      runUnderstand: async () => {
        calls += 1;
        throw new Error("PRIVATE_TRANSPORT_DIAGNOSTIC");
      },
    },
  });
  assert.equal(calls, 2);
  assert.equal(report.cases[0].routeClass, ROUTE_CLASS.INFRASTRUCTURE_FAILURE);
  assert.equal(report.cases[1].routeClass, ROUTE_CLASS.INFRASTRUCTURE_FAILURE);
  assert.ok(
    report.cases
      .slice(2)
      .every((item) => item.routeClass === ROUTE_CLASS.NOT_RUN),
  );
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_TRANSPORT_DIAGNOSTIC/);
});

test("only consecutive infrastructure failures count toward the stop gate", async () => {
  let calls = 0;
  const report = await executeFixedPromptMatrix({
    options: { serial: "device-123", adbPath: "adb" },
    grpcPort: 9_090,
    rankOne: RANK_ONE,
    runtime: {
      makeUserTurnId: (_id, index) => `matrix-reset-${index}`,
      now: () => 1_000,
      runUnderstand: async (_options, _port, prompt, probeOptions) => {
        calls += 1;
        if (calls === 1 || calls === 3 || calls === 4) {
          throw new Error("fixture failure");
        }
        const item = FIXED_PROMPT_MATRIX.find(
          (candidate) => candidate.prompt === prompt,
        );
        return expectedResponses(item, probeOptions.userTurnId, RANK_ONE);
      },
    },
  });
  assert.equal(calls, 4);
  assert.equal(report.cases[0].routeClass, ROUTE_CLASS.INFRASTRUCTURE_FAILURE);
  assert.equal(report.cases[1].status, "pass");
  assert.equal(report.cases[2].routeClass, ROUTE_CLASS.INFRASTRUCTURE_FAILURE);
  assert.equal(report.cases[3].routeClass, ROUTE_CLASS.INFRASTRUCTURE_FAILURE);
  assert.ok(
    report.cases
      .slice(4)
      .every((item) => item.routeClass === ROUTE_CLASS.NOT_RUN),
  );
});

test("matrix main preserves the exact readiness gate before any probe", async () => {
  const order = [];
  let printed = null;
  const report = {
    mode: "raw_aibus_prompt_matrix",
    cases: [],
    summary: { pass: 0, fail: 0, total: 0 },
  };
  const exitCode = await main([...LIVE_ARGS, "--json"], {
    loadExpectedServerIdentity: async () => {
      order.push("release");
      return EXPECTED_IDENTITY;
    },
    verifyExplicitDevice: async () => order.push("serial"),
    collectInstalledServerIdentity: async () => {
      order.push("identity");
      return { packageName: "fixture" };
    },
    readAdminToken: async () => {
      order.push("token");
      return "PRIVATE_ADMIN_TOKEN";
    },
    collectReadiness: async () => {
      order.push("readiness");
      return { fixture: true };
    },
    evaluateReadiness: (snapshot, options) => {
      order.push("evaluate");
      assert.deepEqual(snapshot.packageIdentity, { packageName: "fixture" });
      assert.equal(options.expectedIdentity, EXPECTED_IDENTITY);
      return {
        checks: [{ status: CHECK_STATUS.PASS }],
        context: { grpcPort: 9_090 },
      };
    },
    collectFixedMusicRankOne: async () => {
      order.push("provider");
      return RANK_ONE;
    },
    executeFixedPromptMatrix: async ({ grpcPort, rankOne }) => {
      order.push("matrix");
      assert.equal(grpcPort, 9_090);
      assert.equal(rankOne, RANK_ONE);
      return report;
    },
    printReport: (value, options) => {
      order.push("print");
      printed = { value, options };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(order, [
    "release",
    "serial",
    "identity",
    "token",
    "readiness",
    "evaluate",
    "provider",
    "matrix",
    "print",
  ]);
  assert.equal(printed.value, report);
  assert.deepEqual(printed.options.knownSecrets, ["PRIVATE_ADMIN_TOKEN"]);
});

test("holdout registry has exactly 6 required IDs with stable hash", () => {
  assert.equal(REQUIRED_HOLDOUT_IDS.length, 6, "expected exactly 6 required holdouts");

  // Verify IDs are sorted and unique
  const sorted = [...REQUIRED_HOLDOUT_IDS].sort();
  assert.deepEqual([...REQUIRED_HOLDOUT_IDS], sorted, "holdout IDs must be sorted");
  assert.equal(new Set(REQUIRED_HOLDOUT_IDS).size, REQUIRED_HOLDOUT_IDS.length, "holdout IDs must be unique");

  // Verify hash matches computed value
  let hash = 0;
  for (const id of sorted) {
    for (const byte of Buffer.from(id)) {
      hash = ((hash * 31) + byte) | 0;
    }
  }
  const computedHash = `holdout-v3-${(hash >>> 0).toString(16)}`;
  assert.equal(HOLDOUT_SET_HASH, computedHash, "holdout set hash mismatch");
});

test("offline tier is honestly named as scripted contract eval", () => {
  assert.equal(OFFLINE_TIER_NAME, "scripted_contract_eval");
  assert.equal(PROMPT_COMPARISON_UNAVAILABLE, "prompt_comparison_unavailable");
});

test("report includes holdout registry and tier name", async () => {
  const report = await executeFixedPromptMatrix({
    options: { serial: "device-123", adbPath: "adb" },
    grpcPort: 9_090,
    rankOne: RANK_ONE,
    runtime: {
      makeUserTurnId: (_id, index) => `matrix-holdout-${index}`,
      now: () => 1_000,
      runUnderstand: async (_options, _port, prompt, probeOptions) => {
        const item = FIXED_PROMPT_MATRIX.find((c) => c.prompt === prompt);
        return expectedResponses(item, probeOptions.userTurnId, RANK_ONE);
      },
    },
  });

  assert.equal(report.tier, OFFLINE_TIER_NAME);
  assert.deepEqual(report.holdoutRegistry.requiredIds, [...REQUIRED_HOLDOUT_IDS]);
  assert.equal(report.holdoutRegistry.count, 6);
  assert.equal(report.holdoutRegistry.hash, HOLDOUT_SET_HASH);
});

test("mutation test: semantically inverted prompt with same needles fails classification", () => {
  // Create a response that has the right substring needles but wrong semantic meaning
  const item = FIXED_PROMPT_MATRIX.find((c) => c.id === "agentic_ice_explanation");
  assert.ok(item, "ice explanation case must exist");

  // Create a response with correct route but inverted semantic content
  const invertedThought = "I should return the final answer from bounded read-only planning";
  const invertedInput = JSON.stringify({
    Response: "Ice sinks because it is denser than liquid water.",
  });

  const responses = actionResponses({
    action: "Respond",
    thought: invertedThought,
    input: invertedInput,
    parentIdentifier: "mutation-test-turn",
  });

  const result = classifyMatrixResponse(item, responses, {
    userTurnId: "mutation-test-turn",
    elapsedMs: 100,
    rankOne: RANK_ONE,
  });

  // Route and action alone are insufficient: the inverted semantic answer
  // must fail the case-level content check.
  assert.equal(result.status, "fail");
  assert.equal(result.routeClass, ROUTE_CLASS.AGENTIC_FINAL_ANSWER);
  assert.equal(result.structure.responseContentValid, false);

  // However, the serialized report must not contain the inverted semantic content
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("Ice sinks"), false, "inverted content should not leak");
});

test("strict gate requires all holdout IDs to be registered", () => {
  // Verify that the holdout registry is complete and immutable
  const expectedIds = [
    "ambiguous_same_name_place_holdout",
    "capital_then_remote_weather_locked_holdout",
    "exact_reset_near_miss_holdout",
    "provider_failure_holdout",
    "ranked_music_then_album_followup_holdout",
    "translation_catalog_holdout",
  ];

  assert.deepEqual([...REQUIRED_HOLDOUT_IDS], expectedIds);

  // Verify count and hash are consistent
  assert.equal(REQUIRED_HOLDOUT_IDS.length, 6);
  assert.ok(HOLDOUT_SET_HASH.startsWith("holdout-v3-"));
});
