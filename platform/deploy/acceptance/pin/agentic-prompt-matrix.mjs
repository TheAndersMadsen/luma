#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  ASSISTANT_USER,
  CHECK_STATUS,
  RELEASE_SEQUENCE,
  SERVER_SOURCE,
  evaluateReadiness,
  redactSensitive,
  validateSerial,
  validateUserTurnId,
} from "./agentic-release-smoke-lib.mjs";
import {
  collectFixedMusicRankOne,
  collectInstalledServerIdentity,
  collectReadiness,
  readAdminToken,
  runUnderstand,
  verifyExplicitDevice,
} from "./agentic-release-smoke.mjs";
import { NATIVE_ACTIONS } from "./tier-a-symbols.mjs";

const PROGRAM = "agentic-prompt-matrix";
export const MATRIX_TIMEOUT_MS = 30_000;
export const MAX_MATRIX_CASES = 24;
export const MAX_CONSECUTIVE_INFRASTRUCTURE_FAILURES = 2;
export const GLOBAL_EXCLUDED_TOOLS = Object.freeze([
  NATIVE_ACTIONS.CREATE_MEMORY,
  NATIVE_ACTIONS.SET_VOLUME,
  NATIVE_ACTIONS.INCREMENT_VOLUME,
  NATIVE_ACTIONS.DECREMENT_VOLUME,
]);

/// Required holdout scenario IDs from the Rust prompt-eval tier.
/// These must be present and pass for the strict gate.
export const REQUIRED_HOLDOUT_IDS = Object.freeze([
  "ambiguous_same_name_place_holdout",
  "capital_then_remote_weather_locked_holdout",
  "exact_reset_near_miss_holdout",
  "provider_failure_holdout",
  "ranked_music_then_album_followup_holdout",
  "translation_catalog_holdout",
]);

/// Hash of the holdout set for change detection.
export const HOLDOUT_SET_HASH = "holdout-v3-51d3b78";

/// The offline scripted contract evaluation tier name.
/// This tier uses scripted models to validate fixture consistency,
/// not to evaluate prompt quality or model behavior.
export const OFFLINE_TIER_NAME = "scripted_contract_eval";

/// Marker for scenarios where candidate prompt comparison is not available.
export const PROMPT_COMPARISON_UNAVAILABLE = "prompt_comparison_unavailable";

const GENERIC_NATIVE_ACTION_THOUGHT =
  "I should execute the one validated stock action selected after bounded read-only planning";
const GENERIC_FINAL_ANSWER_THOUGHT =
  "I should return the final answer from bounded read-only planning";
const GENERIC_DECLINE_THOUGHT = "I should safely decline the request";
const GENERIC_LOCATION_PREFLIGHT_THOUGHT =
  "I should obtain the one authenticated device observation required by the read-only plan";
const GENERIC_SAFE_FAILURE_THOUGHT =
  "Bounded agentic planning terminated without an authorized result";
const AGENTIC_SAFE_FAILURE_THOUGHTS = new Set([
  GENERIC_SAFE_FAILURE_THOUGHT,
  "The semantic model was unavailable before it could finish the request",
  "A selected read-only information service failed before returning a result",
  "A selected read-only information service returned an invalid result",
  "The semantic loop reached its repetition or runaway circuit breaker",
  "The required device observation could not be verified",
  "The semantic runtime configuration was invalid",
  "The semantic request or model operation did not match the validated protocol",
]);
const ORDINARY_CHAT_THOUGHT = "I should respond to the user";
const STOCK_TIMEOUT_THOUGHT = "The request exceeded the stock interaction deadline";

export const ROUTE_CLASS = Object.freeze({
  AGENTIC_NATIVE_ACTION: "agentic_native_action",
  AGENTIC_FINAL_ANSWER: "agentic_final_answer",
  AGENTIC_DECLINE: "agentic_decline",
  AGENTIC_LOCATION_PREFLIGHT: "agentic_location_preflight",
  AGENTIC_SAFE_FAILURE: "agentic_safe_failure",
  ORDINARY_CHAT: "ordinary_chat",
  DETERMINISTIC_NATIVE_ACTION: "deterministic_native_action",
  DETERMINISTIC_WEATHER_PREFLIGHT: "deterministic_weather_preflight",
  DETERMINISTIC_TICKLE: "deterministic_tickle",
  STOCK_TIMEOUT: "stock_timeout",
  NO_ACTION: "no_action",
  UNKNOWN: "unknown",
  INFRASTRUCTURE_FAILURE: "infrastructure_failure",
  NOT_RUN: "not_run_after_infrastructure_failures",
});

function fixedCase(value) {
  return Object.freeze({
    ...value,
    allowedRoutes: Object.freeze([...value.allowedRoutes]),
    expectedActions: Object.freeze([...value.expectedActions]),
    allowedKeySets: Object.freeze(
      value.allowedKeySets.map((keys) => Object.freeze([...keys])),
    ),
  });
}

export const FIXED_PROMPT_MATRIX = Object.freeze([
  fixedCase({
    id: "agentic_ice_explanation",
    prompt: "In one short sentence, explain why ice floats on water.",
    allowedRoutes: [ROUTE_CLASS.AGENTIC_FINAL_ANSWER],
    expectedActions: [NATIVE_ACTIONS.RESPOND],
    allowedKeySets: [["Response"]],
    semanticCheck: "ice",
  }),
  fixedCase({
    id: "agentic_sky_explanation",
    prompt: "In one short sentence, explain why the sky looks blue.",
    allowedRoutes: [ROUTE_CLASS.AGENTIC_FINAL_ANSWER],
    expectedActions: [NATIVE_ACTIONS.RESPOND],
    allowedKeySets: [["Response"]],
    semanticCheck: "sky",
  }),
  fixedCase({
    id: "agentic_music_top_read",
    prompt: "What is Michael Jackson's most popular song?",
    allowedRoutes: [ROUTE_CLASS.AGENTIC_FINAL_ANSWER],
    expectedActions: [NATIVE_ACTIONS.RESPOND],
    allowedKeySets: [["Response"]],
    providerCheck: "rank_one_top_track_answer",
  }),
  fixedCase({
    id: "agentic_compound_navigation_preflight",
    prompt: "find the nearest coffee shop and navigate there",
    allowedRoutes: [ROUTE_CLASS.AGENTIC_LOCATION_PREFLIGHT],
    expectedActions: [NATIVE_ACTIONS.GET_CURRENT_LOCATION],
    allowedKeySets: [[]],
  }),
  fixedCase({
    id: "agentic_semantic_charge",
    prompt: "Tell me the battery percentage remaining right now.",
    allowedRoutes: [ROUTE_CLASS.AGENTIC_NATIVE_ACTION],
    expectedActions: [NATIVE_ACTIONS.GET_BATTERY_LEVEL],
    allowedKeySets: [[]],
    modelFallbackControlId: "deterministic_battery_level",
  }),
  fixedCase({
    id: "agentic_semantic_pause",
    prompt: "Pause playback for now.",
    allowedRoutes: [ROUTE_CLASS.AGENTIC_NATIVE_ACTION],
    expectedActions: [NATIVE_ACTIONS.PAUSE_MUSIC],
    allowedKeySets: [[]],
    modelFallbackControlId: "deterministic_pause_music",
  }),
  fixedCase({
    id: "agentic_semantic_weather_preflight",
    prompt: "Should I bring an umbrella here today?",
    allowedRoutes: [ROUTE_CLASS.AGENTIC_LOCATION_PREFLIGHT],
    expectedActions: [NATIVE_ACTIONS.GET_CURRENT_LOCATION],
    allowedKeySets: [[]],
  }),
  fixedCase({
    id: "agentic_quoted_pause_negative",
    prompt: "What happens if I say \"pause the music\"?",
    allowedRoutes: [ROUTE_CLASS.AGENTIC_FINAL_ANSWER],
    expectedActions: [NATIVE_ACTIONS.RESPOND],
    allowedKeySets: [["Response"]],
  }),
  fixedCase({
    id: "deterministic_weather_preflight",
    prompt: "What's the weather like today?",
    allowedRoutes: [ROUTE_CLASS.DETERMINISTIC_WEATHER_PREFLIGHT],
    expectedActions: [NATIVE_ACTIONS.GET_CURRENT_LOCATION],
    allowedKeySets: [[]],
    expectedThought:
      "I should obtain one fresh device location before answering the location request",
  }),
  fixedCase({
    id: "agentic_ranked_music",
    prompt:
      "look up the best songs by Michael Jackson and play the most popular",
    allowedRoutes: [ROUTE_CLASS.AGENTIC_NATIVE_ACTION],
    expectedActions: [NATIVE_ACTIONS.PLAY_MUSIC],
    allowedKeySets: [
      ["Artist", "Track"],
      ["Album", "Artist", "Track"],
    ],
    providerCheck: "rank_one_play_music",
  }),
  fixedCase({
    id: "deterministic_tickle_single",
    prompt: "tickle",
    allowedRoutes: [ROUTE_CLASS.DETERMINISTIC_TICKLE],
    expectedActions: [NATIVE_ACTIONS.TICKLE],
    allowedKeySets: [[]],
    expectedThought:
      `The user invoked the enabled stock ${NATIVE_ACTIONS.TICKLE} prototype with an exact local phrase`,
  }),
  fixedCase({
    id: "deterministic_tickle_fancy",
    prompt: "tickle my fancy",
    allowedRoutes: [ROUTE_CLASS.DETERMINISTIC_TICKLE],
    expectedActions: [NATIVE_ACTIONS.TICKLE],
    allowedKeySets: [[]],
    expectedThought:
      `The user invoked the enabled stock ${NATIVE_ACTIONS.TICKLE} prototype with an exact local phrase`,
  }),
  fixedCase({
    id: "deterministic_tickle_triple",
    prompt: "tickle tickle tickle",
    allowedRoutes: [ROUTE_CLASS.DETERMINISTIC_TICKLE],
    expectedActions: [NATIVE_ACTIONS.TICKLE],
    allowedKeySets: [[]],
    expectedThought:
      `The user invoked the enabled stock ${NATIVE_ACTIONS.TICKLE} prototype with an exact local phrase`,
  }),
  fixedCase({
    id: "deterministic_tickle_negative",
    prompt: "please tickle",
    allowedRoutes: [
      ROUTE_CLASS.NO_ACTION,
      ROUTE_CLASS.AGENTIC_FINAL_ANSWER,
      ROUTE_CLASS.AGENTIC_DECLINE,
      ROUTE_CLASS.AGENTIC_SAFE_FAILURE,
      ROUTE_CLASS.ORDINARY_CHAT,
    ],
    expectedActions: [NATIVE_ACTIONS.RESPOND],
    allowedKeySets: [["Response"]],
    allowEmpty: true,
    acceptAnyStructuredRespond: true,
  }),
  fixedCase({
    id: "deterministic_current_time",
    prompt: "what time is it",
    allowedRoutes: [ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION],
    expectedActions: [NATIVE_ACTIONS.GET_CURRENT_TIME],
    allowedKeySets: [[]],
    expectedThought:
      "The user asked for the current time through the stock device action",
  }),
  fixedCase({
    id: "deterministic_battery_level",
    prompt: "battery level",
    allowedRoutes: [ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION],
    expectedActions: [NATIVE_ACTIONS.GET_BATTERY_LEVEL],
    allowedKeySets: [[]],
    expectedThought: "The user asked for the stock battery status",
  }),
  fixedCase({
    id: "deterministic_pause_music",
    prompt: "pause playback",
    allowedRoutes: [ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION],
    expectedActions: [NATIVE_ACTIONS.PAUSE_MUSIC],
    allowedKeySets: [[]],
    expectedThought: "I should pause the stock music experience",
  }),
  fixedCase({
    id: "deterministic_connectivity",
    prompt: "am i online",
    allowedRoutes: [ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION],
    expectedActions: [NATIVE_ACTIONS.AM_I_ONLINE],
    allowedKeySets: [[]],
    expectedThought: "The user asked for the stock connectivity status",
  }),
  fixedCase({
    id: "deterministic_current_volume",
    prompt: "what is the current volume",
    allowedRoutes: [ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION],
    expectedActions: [NATIVE_ACTIONS.GET_CURRENT_VOLUME],
    allowedKeySets: [[]],
    expectedThought: "The user asked for the current volume",
  }),
  fixedCase({
    id: "deterministic_bluetooth_status",
    prompt: "is bluetooth on",
    allowedRoutes: [ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION],
    expectedActions: [NATIVE_ACTIONS.GET_BLUETOOTH_STATUS],
    allowedKeySets: [[]],
    expectedThought: "The user asked for the stock Bluetooth status",
  }),
  fixedCase({
    id: "deterministic_airplane_status",
    prompt: "airplane mode status",
    allowedRoutes: [ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION],
    expectedActions: [NATIVE_ACTIONS.GET_AIRPLANE_MODE_STATUS],
    allowedKeySets: [[]],
    expectedThought: "The user asked for the stock airplane-mode status",
  }),
  fixedCase({
    id: "deterministic_capture_photo",
    prompt: "take a photo",
    allowedRoutes: [ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION],
    expectedActions: [NATIVE_ACTIONS.CAPTURE_PHOTOGRAPH],
    allowedKeySets: [[]],
    expectedThought:
      "The user explicitly asked the stock camera to take a photograph",
  }),
  fixedCase({
    id: "deterministic_privacy_mode",
    prompt: "enter privacy mode",
    allowedRoutes: [ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION],
    expectedActions: [NATIVE_ACTIONS.ENTER_PRIVACY_MODE],
    allowedKeySets: [[]],
    expectedThought:
      "The user explicitly asked the stock device to enter privacy mode",
  }),
  fixedCase({
    id: "agentic_dependent_capital_weather",
    prompt: "what is the weather in the capital of Australia?",
    allowedRoutes: [ROUTE_CLASS.AGENTIC_FINAL_ANSWER],
    expectedActions: [NATIVE_ACTIONS.RESPOND],
    allowedKeySets: [["Response"]],
    semanticCheck: "dependent_capital_weather",
    expectedPlace: "Canberra",
    expectedCountry: "Australia",
  }),
]);

function validateFixedMatrix(matrix) {
  if (
    !Array.isArray(matrix) ||
    matrix.length === 0 ||
    matrix.length > MAX_MATRIX_CASES
  ) {
    throw new Error("invalid fixed prompt matrix size");
  }
  const ids = new Set();
  for (const item of matrix) {
    if (
      typeof item.id !== "string" ||
      !/^[a-z0-9_]{1,80}$/.test(item.id) ||
      ids.has(item.id)
    ) {
      throw new Error("invalid fixed prompt matrix identifier");
    }
    ids.add(item.id);
    if (
      typeof item.prompt !== "string" ||
      item.prompt.length === 0 ||
      Buffer.byteLength(item.prompt) > 512 ||
      item.prompt.includes("\0") ||
      item.prompt.split("").some(
        (character) =>
          character !== "\n" &&
          character !== "\r" &&
          character !== "\t" &&
          character.charCodeAt(0) < 0x20,
      )
    ) {
      throw new Error("invalid fixed public prompt");
    }
    if (
      item.expectedActions.length === 0 ||
      item.allowedRoutes.length === 0 ||
      item.allowedKeySets.length === 0
    ) {
      throw new Error("invalid fixed prompt expectation");
    }
  }

  const byId = new Map(matrix.map((item) => [item.id, item]));
  for (const item of matrix) {
    if (item.modelFallbackControlId === undefined) continue;
    const control = byId.get(item.modelFallbackControlId);
    if (
      item.allowedRoutes.length !== 1 ||
      item.allowedRoutes[0] !== ROUTE_CLASS.AGENTIC_NATIVE_ACTION ||
      control === undefined ||
      control.allowedRoutes.length !== 1 ||
      control.allowedRoutes[0] !== ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION ||
      control.prompt === item.prompt ||
      control.expectedActions.length !== item.expectedActions.length ||
      !control.expectedActions.every(
        (action, index) => action === item.expectedActions[index],
      )
    ) {
      throw new Error("invalid model-fallback control pairing");
    }
  }
}

validateFixedMatrix(FIXED_PROMPT_MATRIX);

const DETERMINISTIC_THOUGHT_ROUTES = new Map(
  FIXED_PROMPT_MATRIX.filter(
    (item) =>
      item.expectedThought !== undefined &&
      item.allowedRoutes[0] !== ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION,
  ).map((item) => [item.expectedThought, item.allowedRoutes[0]]),
);

function usage() {
  return [
    "Usage:",
    "  node platform/deploy/acceptance/pin/agentic-prompt-matrix.mjs --serial SERIAL [--json]",
    "",
    "Runs a compiled fixed public prompt matrix against raw AIBus on the exact accepted release.",
    "Returned native actions are classified but never dispatched.",
  ].join("\n");
}

export function parseMatrixCliArgs(argv) {
  const options = { serial: null, adbPath: "adb", json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error("missing command value");
      return value;
    };
    switch (argument) {
      case "--serial":
      case "-s":
        options.serial = next();
        break;
      case "--adb":
        options.adbPath = next();
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error("unknown command option");
    }
  }
  if (options.help) return options;
  validateSerial(options.serial);
  if (
    typeof options.adbPath !== "string" ||
    options.adbPath.length === 0 ||
    options.adbPath.includes("\0")
  ) {
    throw new Error("invalid ADB executable path");
  }
  return options;
}

function latencyBucket(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "timeout_or_error";
  if (elapsedMs < 5_000) return "under_5s";
  if (elapsedMs < 10_000) return "5_to_10s";
  if (elapsedMs < 20_000) return "10_to_20s";
  if (elapsedMs <= MATRIX_TIMEOUT_MS) return "20_to_30s";
  return "over_30s";
}

function structure(value = false) {
  return {
    cardinalityValid: value,
    actionEnvelopeValid: value,
    assistantTurnValid: value,
    serverSourceValid: value,
    parentLinkValid: value,
    identifierValid: value,
    emptyDevicePayload: value,
    nonFinal: value,
    jsonObjectValid: value,
    expectedKeysValid: value,
    responseContentValid: value,
  };
}

function parseActionInput(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.getPrototypeOf(parsed) === Object.prototype
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function keysMatch(input, allowedKeySets) {
  if (input === null) return false;
  const actual = Object.keys(input).sort().join("\0");
  return allowedKeySets.some(
    (allowed) => [...allowed].sort().join("\0") === actual,
  );
}

function classifyRoute(item, response) {
  if (response?.kind !== "action") return ROUTE_CLASS.UNKNOWN;
  if (
    response.thought === GENERIC_NATIVE_ACTION_THOUGHT &&
    response.action !== NATIVE_ACTIONS.RESPOND
  ) {
    return ROUTE_CLASS.AGENTIC_NATIVE_ACTION;
  }
  if (
    response.thought === GENERIC_FINAL_ANSWER_THOUGHT &&
    response.action === NATIVE_ACTIONS.RESPOND
  ) {
    return ROUTE_CLASS.AGENTIC_FINAL_ANSWER;
  }
  if (
    response.thought === GENERIC_DECLINE_THOUGHT &&
    response.action === NATIVE_ACTIONS.RESPOND
  ) {
    return ROUTE_CLASS.AGENTIC_DECLINE;
  }
  if (
    response.thought === GENERIC_LOCATION_PREFLIGHT_THOUGHT &&
    response.action === NATIVE_ACTIONS.GET_CURRENT_LOCATION
  ) {
    return ROUTE_CLASS.AGENTIC_LOCATION_PREFLIGHT;
  }
  if (
    AGENTIC_SAFE_FAILURE_THOUGHTS.has(response.thought) &&
    response.action === NATIVE_ACTIONS.RESPOND
  ) {
    return ROUTE_CLASS.AGENTIC_SAFE_FAILURE;
  }
  if (
    response.thought === ORDINARY_CHAT_THOUGHT &&
    response.action === NATIVE_ACTIONS.RESPOND
  ) {
    return ROUTE_CLASS.ORDINARY_CHAT;
  }
  if (
    response.thought === STOCK_TIMEOUT_THOUGHT &&
    response.action === NATIVE_ACTIONS.RESPOND
  ) {
    return ROUTE_CLASS.STOCK_TIMEOUT;
  }
  const fixedRoute = DETERMINISTIC_THOUGHT_ROUTES.get(response.thought);
  if (fixedRoute !== undefined) return fixedRoute;

  // A deterministic-native control is an exact stock phrase paired with one
  // expected fieldless action. Its route must not depend on human-readable
  // thought wording, which is presentation rather than protocol. Recognized
  // agentic/timeout/chat markers are handled above, so they cannot be relabeled
  // as deterministic merely because the action happens to match.
  if (
    item.allowedRoutes.length === 1 &&
    item.allowedRoutes[0] === ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION &&
    item.expectedActions.includes(response.action) &&
    typeof response.thought === "string" &&
    response.thought.trim().length > 0
  ) {
    return ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION;
  }
  return ROUTE_CLASS.UNKNOWN;
}

function responseContentValid(item, input) {
  if (input === null) return false;
  if (item.expectedActions.includes(NATIVE_ACTIONS.RESPOND)) {
    const response = input.Response;
    if (
      typeof response !== "string" ||
      response.trim().length === 0 ||
      Buffer.byteLength(response) > 16 * 1024
    ) {
      return false;
    }
    if (item.semanticCheck === "ice") {
      return /(?:less dense|density)/i.test(response) && /water/i.test(response);
    }
    if (item.semanticCheck === "sky") {
      return /(?:scatter|scattering|rayleigh|wavelength)/i.test(response);
    }
    if (item.semanticCheck === "dependent_capital_weather") {
      return (
        /(?:weather|temperature|forecast|rain|sun|cloud|humid|degree|celsius|fahrenheit|°)/i.test(response) &&
        providerTextContains(response, item.expectedPlace) &&
        providerTextContains(response, item.expectedCountry)
      );
    }
  }
  return true;
}

function validRankOne(rankOne) {
  return (
    rankOne !== null &&
    typeof rankOne === "object" &&
    typeof rankOne.title === "string" &&
    rankOne.title.length > 0 &&
    Array.isArray(rankOne.artists) &&
    rankOne.artists.length > 0 &&
    rankOne.artists.every(
      (artist) => typeof artist === "string" && artist.length > 0,
    ) &&
    (rankOne.album === undefined || typeof rankOne.album === "string")
  );
}

function normalized(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    : "";
}

function providerTextContains(response, expected) {
  const haystack = normalized(response);
  const needle = normalized(expected);
  if (haystack.length === 0 || needle.length === 0) return false;

  const wordCharacter = (character) =>
    character !== undefined && /[\p{L}\p{N}]/u.test(character);
  const codePointBefore = (value, index) => {
    if (index <= 0) return undefined;
    const trailing = value.charCodeAt(index - 1);
    if (
      trailing >= 0xdc00 &&
      trailing <= 0xdfff &&
      index >= 2 &&
      value.charCodeAt(index - 2) >= 0xd800 &&
      value.charCodeAt(index - 2) <= 0xdbff
    ) {
      return value.slice(index - 2, index);
    }
    return value[index - 1];
  };
  const codePointAt = (value, index) =>
    index >= value.length
      ? undefined
      : String.fromCodePoint(value.codePointAt(index));
  const hasWordCharacters = Array.from(needle).some(wordCharacter);
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) return false;
    const before = codePointBefore(haystack, index);
    const afterIndex = index + needle.length;
    const after = codePointAt(haystack, afterIndex);
    const leftBounded = !hasWordCharacters || !wordCharacter(before);
    const rightBounded = !hasWordCharacters || !wordCharacter(after);
    if (leftBounded && rightBounded) return true;
    offset = index + 1;
  }
  return false;
}

function providerMatches(item, input, rankOne) {
  if (!validRankOne(rankOne) || input === null) return false;
  if (item.providerCheck === "rank_one_top_track_answer") {
    return (
      providerTextContains(input.Response, rankOne.title) &&
      rankOne.artists.some((artist) =>
        providerTextContains(input.Response, artist),
      )
    );
  }
  if (item.providerCheck === "rank_one_play_music") {
    return (
      input.Track === rankOne.title &&
      normalized(input.Artist) === "michael jackson" &&
      rankOne.artists.some(
        (artist) => normalized(artist) === normalized(input.Artist),
      ) &&
      (input.Album === undefined || input.Album === rankOne.album)
    );
  }
  return false;
}

function publicCaseResult({
  item,
  status,
  routeClass,
  actionName,
  structural,
  elapsedMs,
  providerMatch,
}) {
  return {
    id: item.id,
    status,
    routeClass,
    actionName,
    structure: structural,
    latencyBucket: latencyBucket(elapsedMs),
    ...(item.providerCheck === undefined ? {} : { providerMatch }),
  };
}

export function classifyMatrixResponse(
  item,
  responses,
  { userTurnId, elapsedMs, rankOne = null },
) {
  if (!Array.isArray(responses)) {
    throw new Error("decoded response list is required");
  }
  if (responses.length === 0 && item.allowEmpty === true) {
    return publicCaseResult({
      item,
      status: "pass",
      routeClass: ROUTE_CLASS.NO_ACTION,
      actionName: null,
      structural: structure(true),
      elapsedMs,
      providerMatch: item.providerCheck === undefined ? undefined : false,
    });
  }

  const response = responses.length === 1 ? responses[0] : null;
  const input = response?.kind === "action" ? parseActionInput(response.input) : null;
  const structural = structure(false);
  structural.cardinalityValid = responses.length === 1;
  structural.actionEnvelopeValid = response?.kind === "action";
  structural.assistantTurnValid = response?.user === ASSISTANT_USER;
  structural.serverSourceValid = response?.source === SERVER_SOURCE;
  structural.parentLinkValid =
    response?.hasParentIdentifier === true &&
    response?.parentIdentifier === userTurnId;
  structural.identifierValid =
    response?.hasIdentifier === true &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      response?.identifier ?? "",
    );
  structural.emptyDevicePayload = response?.devicePayloadBytes === 0;
  structural.nonFinal = response?.isFinal === false;
  structural.jsonObjectValid = input !== null;
  structural.expectedKeysValid = keysMatch(input, item.allowedKeySets);
  structural.responseContentValid = responseContentValid(item, input);

  const routeClass = classifyRoute(item, response);
  const actionName =
    response?.kind === "action" && typeof response.action === "string"
      ? response.action
      : null;
  const actionValid = item.expectedActions.includes(actionName);
  const routeValid =
    (item.acceptAnyStructuredRespond === true &&
      actionName === NATIVE_ACTIONS.RESPOND) ||
    item.allowedRoutes.includes(routeClass);
  const structuralValid = Object.values(structural).every(Boolean);
  const providerMatch =
    item.providerCheck === undefined
      ? undefined
      : providerMatches(item, input, rankOne);
  const passed =
    structuralValid &&
    actionValid &&
    routeValid &&
    (item.providerCheck === undefined || providerMatch === true);

  return publicCaseResult({
    item,
    status: passed ? "pass" : "fail",
    routeClass,
    actionName,
    structural,
    elapsedMs,
    providerMatch,
  });
}

function infrastructureFailure(item, elapsedMs) {
  return publicCaseResult({
    item,
    status: "fail",
    routeClass: ROUTE_CLASS.INFRASTRUCTURE_FAILURE,
    actionName: null,
    structural: structure(false),
    elapsedMs,
    providerMatch: item.providerCheck === undefined ? undefined : false,
  });
}

function notRun(item) {
  return publicCaseResult({
    item,
    status: "fail",
    routeClass: ROUTE_CLASS.NOT_RUN,
    actionName: null,
    structural: structure(false),
    elapsedMs: Number.NaN,
    providerMatch: item.providerCheck === undefined ? undefined : false,
  });
}

function buildReport(cases) {
  const pass = cases.filter((item) => item.status === "pass").length;
  const fail = cases.length - pass;
  return {
    mode: "raw_aibus_prompt_matrix",
    tier: OFFLINE_TIER_NAME,
    releaseSequence: RELEASE_SEQUENCE,
    safety: {
      nativeActionsDispatched: false,
      volumeMutationsExcluded: true,
      promptsPrinted: false,
      rawResponsesPrinted: false,
      concurrency: 1,
    },
    holdoutRegistry: {
      requiredIds: [...REQUIRED_HOLDOUT_IDS],
      count: REQUIRED_HOLDOUT_IDS.length,
      hash: HOLDOUT_SET_HASH,
    },
    cases,
    summary: { pass, fail, total: cases.length },
  };
}

export async function executeFixedPromptMatrix({
  options,
  grpcPort,
  rankOne = null,
  runtime = {},
}) {
  const run = runtime.runUnderstand ?? runUnderstand;
  const now = runtime.now ?? Date.now;
  const makeUserTurnId =
    runtime.makeUserTurnId ?? (() => `matrix-${randomUUID()}`);
  const cases = [];
  const seenTurnIds = new Set();
  let consecutiveInfrastructureFailures = 0;

  for (let index = 0; index < FIXED_PROMPT_MATRIX.length; index += 1) {
    const item = FIXED_PROMPT_MATRIX[index];
    if (
      consecutiveInfrastructureFailures >=
      MAX_CONSECUTIVE_INFRASTRUCTURE_FAILURES
    ) {
      cases.push(notRun(item));
      continue;
    }

    const userTurnId = validateUserTurnId(makeUserTurnId(item.id, index));
    if (seenTurnIds.has(userTurnId)) {
      throw new Error("matrix user turn identifiers must be unique");
    }
    seenTurnIds.add(userTurnId);
    const startedAt = now();
    try {
      const responses = await run(options, grpcPort, item.prompt, {
        timeoutMs: MATRIX_TIMEOUT_MS,
        userTurnId,
        excludedTools: [...GLOBAL_EXCLUDED_TOOLS],
      });
      consecutiveInfrastructureFailures = 0;
      cases.push(
        classifyMatrixResponse(item, responses, {
          userTurnId,
          elapsedMs: Math.max(0, now() - startedAt),
          rankOne,
        }),
      );
    } catch {
      consecutiveInfrastructureFailures += 1;
      cases.push(
        infrastructureFailure(item, Math.max(0, now() - startedAt)),
      );
    }
  }
  return buildReport(cases);
}

function renderHumanReport(report) {
  const lines = [
    "Agentic raw AIBus prompt matrix",
    "Safety: returned actions were classified and never dispatched",
    "",
  ];
  for (const item of report.cases) {
    const structureValid = Object.values(item.structure).every(Boolean);
    lines.push(
      `[${item.status.toUpperCase()}] ${item.id} route=${item.routeClass} action=${item.actionName ?? "none"} structure=${structureValid ? "pass" : "fail"} latency=${item.latencyBucket}${item.providerMatch === undefined ? "" : ` provider_match=${item.providerMatch}`}`,
    );
  }
  lines.push(
    "",
    `Summary: ${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.total} total.`,
  );
  return lines.join("\n");
}

function printReport(report, { json, knownSecrets = [] }) {
  const safe = redactSensitive(report, { knownSecrets });
  process.stdout.write(
    json ? `${JSON.stringify(safe, null, 2)}\n` : `${renderHumanReport(safe)}\n`,
  );
}

const DEFAULT_RUNTIME = Object.freeze({
  verifyExplicitDevice,
  collectInstalledServerIdentity,
  readAdminToken,
  collectReadiness,
  evaluateReadiness,
  collectFixedMusicRankOne,
  executeFixedPromptMatrix,
  printReport,
});

export async function main(
  argv = process.argv.slice(2),
  dependencyOverrides = {},
) {
  const runtime = { ...DEFAULT_RUNTIME, ...dependencyOverrides };
  let adminToken = null;
  try {
    const options = parseMatrixCliArgs(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }

    await runtime.verifyExplicitDevice(options);
    const packageIdentity =
      await runtime.collectInstalledServerIdentity(options);
    adminToken = await runtime.readAdminToken();
    const snapshot = await runtime.collectReadiness(options, adminToken);
    const readiness = runtime.evaluateReadiness({
      ...snapshot,
      packageIdentity,
    });
    if (
      !Array.isArray(readiness?.checks) ||
      !readiness.checks.every((check) => check.status === CHECK_STATUS.PASS) ||
      !Number.isInteger(readiness?.context?.grpcPort)
    ) {
      throw new Error("release readiness prerequisites failed");
    }

    let rankOne = null;
    try {
      rankOne = await runtime.collectFixedMusicRankOne(options, adminToken);
    } catch {}
    const report = await runtime.executeFixedPromptMatrix({
      options,
      grpcPort: readiness.context.grpcPort,
      rankOne,
      runtime,
    });
    runtime.printReport(report, {
      json: options.json,
      knownSecrets: [adminToken],
    });
    adminToken = null;
    return report.summary.fail === 0 ? 0 : 1;
  } catch {
    adminToken = null;
    process.stderr.write(`${PROGRAM}: verification failed safely\n`);
    return 2;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = await main();
