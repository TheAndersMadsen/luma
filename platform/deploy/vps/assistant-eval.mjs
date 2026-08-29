#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");

export const ASSISTANT_CASES = Object.freeze([
  Object.freeze({
    id: "reasoning",
    prompt: "Explain in one sentence why the daytime sky appears blue.",
    requiredActions: ["Respond"],
    forbiddenActions: [],
    route: "a1",
    terminal: "answered",
  }),
  Object.freeze({
    id: "fresh-web-search",
    prompt: "Search the web for the latest news in Denmark and summarize one result.",
    requiredActions: ["web_search", "Respond"],
    forbiddenActions: [],
    route: "a1",
    terminal: "answered",
    answerPattern: /\b(?:Denmark|Danish|Copenhagen|Greenland)\b/iu,
    forbiddenAnswerPattern:
      /(?:couldn['’]t|could not|unable to) find|no reliable (?:current )?(?:result|news)/iu,
  }),
  Object.freeze({
    id: "compound-research",
    prompt: "Make two separate lookups: search the web for the latest news in Denmark, look up the Eiffel Tower on Wikipedia, then summarize both.",
    requiredActions: ["web_search", "wikipedia", "Respond"],
    forbiddenActions: [],
    route: "a2",
    terminal: "answered",
  }),
  Object.freeze({
    id: "explicit-lookup",
    prompt: "Look up the Eiffel Tower and tell me how tall it is.",
    requiredActions: ["wikipedia", "Respond"],
    forbiddenActions: [],
    route: "a1",
    terminal: "answered",
  }),
  Object.freeze({
    id: "current-product-price",
    prompt: "How much does a Humane AI Pin cost?",
    requiredActions: ["ask_online", "Respond"],
    forbiddenActions: [],
    route: "a1",
    terminal: "answered",
    answerPattern:
      /discontinued|no longer (?:sold|available)|not (?:currently )?(?:sold|available)/iu,
  }),
  Object.freeze({
    id: "nutrition-oatmeal",
    prompt: "What are the nutrition facts for oatmeal?",
    requiredActions: ["food_lookup", "Respond"],
    forbiddenActions: [],
    exactActionCounts: { food_lookup: 1 },
    route: "a1",
    terminal: "answered",
    answerPattern: /\b(?:calories|kcal|protein|fiber|fibre|carbohydrate|fat)\b/iu,
  }),
  Object.freeze({
    id: "show-my-notes",
    prompt: "Show my notes.",
    requiredActions: ["recall_memory", "Respond"],
    forbiddenActions: [],
    exactActionCounts: { recall_memory: 1 },
    route: "a1",
    terminal: "answered",
  }),
  ...[
    [
      "future-weather-limit",
      "What will the weather be tomorrow?",
      /future weather forecasts are not available/iu,
      ["GetCurrentLocation", "current_weather", "weather"],
    ],
    [
      "transit-routing-limit",
      "Give me transit directions to Nyhavn.",
      /transit routing is not supported/iu,
      ["GetCurrentLocation", "route"],
    ],
  ].map(([id, prompt, answerPattern, forbiddenActions]) => Object.freeze({
    id,
    prompt,
    requiredActions: ["Respond"],
    forbiddenActions,
    exactActionCounts: { Respond: 1 },
    answerPattern,
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  })),
  ...[
    ["show-timers", "Show my timers.", "Timer"],
    ["show-alarms", "Show my alarms.", "Alarm"],
  ].map(([id, prompt, action]) => Object.freeze({
    id,
    prompt,
    requiredActions: [action],
    forbiddenActions: ["Respond"],
    exactActionCounts: { [action]: 1 },
    expectedActionInputs: { [action]: { Request: prompt } },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  })),
  ...[
    ["food-log-today", "What have I eaten today?"],
    ["food-calories-today", "How many calories have I eaten today?"],
    ["food-log-three-days", "Show my food log for the last three days."],
  ].map(([id, prompt]) => Object.freeze({
    id,
    prompt,
    requiredActions: ["ManageNutrition"],
    forbiddenActions: ["Respond", "PlayMusic"],
    exactActionCounts: { ManageNutrition: 1 },
    expectedActionInputs: { ManageNutrition: { Request: prompt } },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  })),
  ...[
    ["reset-session", "Reset session.", "ClearUnderstandingContext", {}],
    [
      "messages-recent-read",
      "Read my recent messages.",
      "DisplayMessages",
      { IDs: [], MessageCount: 10, Person: [] },
    ],
    [
      "messages-search-read",
      "Search my messages for dinner.",
      "MessageSearch",
      { Person: [], Query: "dinner" },
    ],
    ["messages-open-ui", "Open messages.", "OpenMessagesMainMenu", {}],
    ["notifications-catch-up-read", "Catch me up.", "CatchMeUp", {}],
    ["contacts-open-ui", "Open contacts.", "OpenContacts", {}],
    [
      "contacts-search-read",
      "Search contacts for Alex.",
      "Contacts",
      { Request: "Search contacts for Alex" },
    ],
    [
      "contacts-phone-read",
      "What is the phone number for Alex?",
      "Contacts",
      { Request: "What is the phone number for Alex" },
    ],
    [
      "contacts-quick-read",
      "Who are my quick messaging contacts?",
      "Contacts",
      { Request: "Who are my quick messaging contacts" },
    ],
    ["dialer-open-ui", "Open dialer.", "OpenDialerHome", {}],
    ["dialpad-open-ui", "Open the dial pad.", "OpenDialpad", {}],
    ["recent-calls-open-ui", "Open recent calls.", "OpenRecentCalls", {}],
    [
      "translation-good-morning-french",
      "Translate good morning from English to French.",
      "Translate",
      { Source: "English", Target: "French", Text: "good morning" },
    ],
    [
      "translation-hello-spanish",
      "Translate hello to Spanish.",
      "Translate",
      { Target: "Spanish", Text: "hello" },
    ],
    [
      "translation-thank-you-japanese",
      "How do you say thank you in Japanese?",
      "Translate",
      { Target: "Japanese", Text: "thank you" },
    ],
    [
      "recent-photos-open-ui",
      "Show my recent photos.",
      "OpenRecentPhotos",
      { TriggeredFromTouchpad: false },
    ],
    ["music-queue-read", "What's in my music queue?", "GetMusicQueue", {}],
    [
      "vision-action-count-read",
      "Tell me the number of vision actions.",
      "GetIfThenMapSize",
      {},
    ],
  ].map(([id, prompt, action, input]) => Object.freeze({
    id,
    prompt,
    requiredActions: [action],
    forbiddenActions: [
      "Respond",
      "CallPerson",
      "ComposeMessage",
      "CapturePhotograph",
      "CaptureVideo",
      "PlayMusic",
      "TurnOffWifi",
      "TurnOffCellularData",
    ],
    exactActionCounts: { [action]: 1 },
    expectedActionInputs: { [action]: input },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  })),
  ...[
    ["walking", "walking"],
    ["driving", "driving"],
    ["cycling", "bicycling"],
  ].map(([wording, mode]) => Object.freeze({
    id: `route-${wording}-nyhavn`,
    prompt: `Give me ${wording} directions to Nyhavn.`,
    requiredActions: ["GetCurrentLocation", "route", "Respond"],
    forbiddenActions: ["nearby"],
    exactActionCounts: { GetCurrentLocation: 1, route: 1 },
    expectedActionInputs: { route: { destination: "Nyhavn", mode } },
    route: "a1",
    terminal: "answered",
    simulateUnlockedPin: true,
    simulateLocation: true,
  })),
  ...[
    ["current-city-read", "What city am I in?", "reverse_geocode", {}, "a1"],
    ["weather-here", "What's the weather here?", "weather", {}, "a1"],
    [
      "weather-umbrella-local",
      "Should I bring an umbrella here today?",
      "weather",
      {},
      "a1",
    ],
    ["nearby-bare", "What's nearby?", "nearby", { query: "" }, "a1"],
    [
      "nearby-coffee",
      "Find coffee shops nearby.",
      "nearby",
      { query: "coffee shops" },
      "a1",
    ],
    [
      "nearest-coffee",
      "Find the nearest coffee shop.",
      "nearby",
      { query: "coffee shop" },
      "a1",
    ],
  ].map(([id, prompt, action, input, route]) => Object.freeze({
    id,
    prompt,
    requiredActions: ["GetCurrentLocation", action, "Respond"],
    forbiddenActions: ["PlayMusic", "CapturePhotograph", "CallPerson"],
    exactActionCounts: { GetCurrentLocation: 1, [action]: 1 },
    expectedActionInputs: { [action]: input },
    route,
    terminal: "answered",
    simulateUnlockedPin: true,
    simulateLocation: true,
  })),
  Object.freeze({
    id: "weather-and-nearby",
    prompt: "What's the weather here and what's nearby?",
    requiredActions: ["GetCurrentLocation", "weather", "nearby", "Respond"],
    forbiddenActions: ["PlayMusic", "CapturePhotograph", "CallPerson"],
    exactActionCounts: { GetCurrentLocation: 1, weather: 1, nearby: 1 },
    expectedActionInputs: { weather: {}, nearby: { query: "" } },
    route: "a2",
    terminal: "answered",
    simulateUnlockedPin: true,
    simulateLocation: true,
  }),
  ...[
    ["pin-current-time", "What time is it?", "GetCurrentTime", {}],
    ["pin-battery-level", "Battery level.", "GetBatteryLevel", {}],
    ["pin-current-volume", "What is the current volume?", "GetCurrentVolume", {}],
    ["pin-online-status", "Am I online?", "AmIOnline", {}],
    ["pin-device-status", "Device status.", "Settings", { Request: "Device status." }],
    ["pin-bluetooth-status", "Is Bluetooth on?", "GetBluetoothStatus", {}],
    ["pin-airplane-status", "Airplane mode status.", "GetAirplaneModeStatus", {}],
    ["pin-phone-number", "What is my phone number?", "GetPhoneNumber", {}],
    ["pin-serial-number", "What is my serial number?", "GetSerialNumber", {}],
    ["pin-current-location", "Where am I?", "GetCurrentLocation", {}],
  ].map(([id, prompt, action, input]) => Object.freeze({
    id,
    prompt,
    requiredActions: [action],
    forbiddenActions: ["Respond"],
    expectedActionInputs: { [action]: input },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  })),
  Object.freeze({
    id: "pin-nutrition-apple",
    prompt: "How many calories are in an apple?",
    requiredActions: ["ManageNutrition"],
    forbiddenActions: ["Respond"],
    expectedActionInputs: {
      ManageNutrition: { Request: "How many calories are in an apple?" },
    },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  }),
  Object.freeze({
    id: "pin-nutrition-eggs",
    prompt: "How much protein is in two eggs?",
    requiredActions: ["ManageNutrition"],
    forbiddenActions: ["Respond"],
    expectedActionInputs: {
      ManageNutrition: { Request: "How much protein is in two eggs?" },
    },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  }),
  Object.freeze({
    id: "pin-world-clock-tokyo",
    prompt: "What time is it in Tokyo?",
    requiredActions: ["WorldClock"],
    forbiddenActions: ["Respond", "GetCurrentTime"],
    expectedActionInputs: { WorldClock: { Location: "Tokyo" } },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  }),
  Object.freeze({
    id: "ambiguous-no-vision",
    prompt: "Um, what was that thing?",
    requiredActions: ["Respond"],
    forbiddenActions: ["UnderstandScene"],
    route: "a1",
    terminal: "answered",
  }),
  Object.freeze({
    id: "tickle-near-miss",
    prompt: "Please tickle.",
    requiredActions: ["Respond"],
    forbiddenActions: ["Tickle"],
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
  }),
  Object.freeze({
    id: "consequential-confirmation",
    prompt: "Call Alex.",
    requiredActions: ["Respond"],
    forbiddenActions: ["CallPerson"],
    route: "a1",
    terminal: "confirmation_required",
  }),
]);

function decodePrometheusString(value) {
  return value.replaceAll(/\\([\\"n])/gu, (_, escaped) => {
    if (escaped === "n") return "\n";
    return escaped;
  });
}

function labelsKey(labels) {
  return JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
}

export function agentRunSamples(scrape) {
  const samples = new Map();
  for (const line of String(scrape).split(/\r?\n/u)) {
    const match = /^cosmos_agent_runs_total\{([^}]*)\}\s+([0-9]+(?:\.[0-9]+)?)$/u.exec(line);
    if (!match) continue;
    const labels = {};
    for (const label of match[1].matchAll(/([a-z_]+)="((?:\\.|[^"])*)"/gu)) {
      labels[label[1]] = decodePrometheusString(label[2]);
    }
    samples.set(labelsKey(labels), { labels, value: Number(match[2]) });
  }
  return samples;
}

export function changedAgentRuns(beforeScrape, afterScrape) {
  const before = agentRunSamples(beforeScrape);
  const after = agentRunSamples(afterScrape);
  const changed = [];
  for (const [key, sample] of after) {
    const delta = sample.value - (before.get(key)?.value ?? 0);
    if (delta > 0) changed.push({ ...sample, delta });
  }
  return changed;
}

export function evaluateAssistantCase(spec, trace, beforeScrape, afterScrape) {
  const failures = [];
  const steps = Array.isArray(trace?.steps) ? trace.steps : [];
  const actions = steps
    .filter((step) => step?.kind === "action" || step?.kind === "answer")
    .map((step) => step.name)
    .filter((name) => typeof name === "string");
  for (const required of spec.requiredActions) {
    if (!actions.includes(required)) failures.push(`missing_action:${required}`);
  }
  for (const forbidden of spec.forbiddenActions) {
    if (actions.includes(forbidden)) failures.push(`forbidden_action:${forbidden}`);
  }
  for (const [action, expected] of Object.entries(spec.exactActionCounts ?? {})) {
    if (actions.filter((name) => name === action).length !== expected) {
      failures.push(`action_count:${action}`);
    }
  }
  for (const [action, expected] of Object.entries(spec.expectedActionInputs ?? {})) {
    const matching = steps
      .filter((step) => step?.kind === "action" && step?.name === action)
      .some((step) => {
        try {
          return JSON.stringify(JSON.parse(step.input)) === JSON.stringify(expected);
        } catch {
          return false;
        }
      });
    if (!matching) failures.push(`action_input:${action}`);
  }
  if (spec.answerPattern) {
    const answers = steps
      .filter((step) => step?.kind === "answer" && step?.name === "Respond")
      .map((step) => step.text)
      .filter((text) => typeof text === "string");
    if (!answers.some((answer) => spec.answerPattern.test(answer))) {
      failures.push("answer_mismatch");
    }
    if (
      spec.forbiddenAnswerPattern &&
      answers.some((answer) => spec.forbiddenAnswerPattern.test(answer))
    ) {
      failures.push("answer_forbidden");
    }
  }
  if (!Number.isFinite(trace?.total_ms) || !Number.isFinite(trace?.device_deadline_ms)) {
    failures.push("malformed_latency");
  } else if (trace.total_ms > trace.device_deadline_ms) {
    failures.push("device_deadline");
  }

  const expectedModelInvoked = spec.modelInvoked ?? true;
  const candidates = changedAgentRuns(beforeScrape, afterScrape).filter(
    ({ labels }) =>
      labels.transport === "legacy" &&
      labels.planner_plane === "cosmos_remote" &&
      labels.model_invoked === String(expectedModelInvoked),
  );
  const run = candidates.find(
    ({ labels }) =>
      labels.route === spec.route &&
      labels.terminal === spec.terminal,
  );
  if (!run) {
    failures.push("missing_model_run");
  } else if (expectedModelInvoked) {
    for (const label of ["model_provider", "model", "model_speed", "reasoning_effort"]) {
      if (!run.labels[label] || run.labels[label] === "unreported") {
        failures.push(`missing_provenance:${label}`);
      }
    }
  }

  return {
    id: spec.id,
    pass: failures.length === 0,
    failures,
    actions,
    totalMs: Number.isFinite(trace?.total_ms) ? trace.total_ms : null,
    run: run
      ? {
          route: run.labels.route,
          terminal: run.labels.terminal,
          modelProvider: run.labels.model_provider,
          model: run.labels.model,
          speed: run.labels.model_speed,
          effort: run.labels.reasoning_effort,
          modelSteps: run.labels.model_steps,
          modelInvoked: run.labels.model_invoked === "true",
        }
      : null,
  };
}

function usage() {
  return "usage: revival eval assistant production [--repeat N] [--json] [--env-file FILE] [--project-name NAME]";
}

export function parseArguments(argv, environment = process.env) {
  const options = {
    repeat: 2,
    json: false,
    envFile: environment.REVIVAL_ENV_FILE,
    projectName: environment.COMPOSE_PROJECT_NAME || "ai-pin-revival",
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (seen.has(name) || !["--repeat", "--json", "--env-file", "--project-name"].includes(name)) {
      throw new Error(usage());
    }
    seen.add(name);
    if (name === "--json") {
      options.json = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw new Error(usage());
    if (name === "--repeat") {
      options.repeat = Number(value);
      if (!Number.isSafeInteger(options.repeat) || options.repeat < 1 || options.repeat > 5) {
        throw new Error("--repeat must be an integer from 1 through 5");
      }
    } else if (name === "--env-file") {
      options.envFile = path.resolve(ROOT, value);
    } else {
      options.projectName = value;
    }
    index += 1;
  }
  if (!options.envFile) throw new Error("REVIVAL_ENV_FILE is required");
  return options;
}

function composeArguments(options) {
  const operatorCompose = path.join(
    process.env.REVIVAL_CONFIG_DIR || "",
    "production",
    "operator.compose.yaml",
  );
  const application = process.env.REVIVAL_COMPOSE_APPLICATION;
  if (!process.env.REVIVAL_CONFIG_DIR || !application) {
    throw new Error("validated production configuration is required");
  }
  return [
    "compose",
    "--project-directory",
    ROOT,
    "--project-name",
    options.projectName,
    "--env-file",
    options.envFile,
    "-f",
    application,
    "-f",
    operatorCompose,
  ];
}

function inAiBus(options, curlArguments, input) {
  const result = spawnSync(
    "docker",
    [...composeArguments(options), "exec", "-T", "ai-bus", "curl", ...curlArguments],
    { encoding: "utf8", input, maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `docker compose exec exited ${result.status}`);
  }
  return result.stdout;
}

function metrics(options) {
  return inAiBus(options, ["--fail", "--silent", "--show-error", "--max-time", "5", "http://127.0.0.1:8080/metrics"]);
}

export function assistantTracePayload(spec) {
  return {
    text: spec.prompt,
    ...(spec.simulateUnlockedPin ? { simulate_unlocked_pin: true } : {}),
    ...(spec.simulateLocation ? { simulate_location: true } : {}),
  };
}

function trace(options, spec) {
  const raw = inAiBus(
    options,
    [
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "30",
      "--header",
      "content-type: application/json",
      "--data-binary",
      "@-",
      "http://127.0.0.1:8080/demo-api/trace",
    ],
    JSON.stringify(assistantTracePayload(spec)),
  );
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("assistant trace returned malformed JSON");
  }
}

export function renderReport(report) {
  const lines = [
    `Cosmos assistant production evaluation: ${report.passed}/${report.total} passed`,
  ];
  for (const result of report.results) {
    const provenance = result.run
      ? ` ${result.run.modelProvider}/${result.run.model} ${result.run.speed} ${result.run.effort}`
      : "";
    lines.push(
      `${result.pass ? "PASS" : "FAIL"} ${result.id} ${result.totalMs ?? "?"}ms ${result.run?.route ?? "no-run"}/${result.run?.terminal ?? "unknown"}${provenance}`,
    );
    if (result.failures.length) lines.push(`  ${result.failures.join(", ")}`);
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const results = [];
  for (let round = 0; round < options.repeat; round += 1) {
    for (const spec of ASSISTANT_CASES) {
      const before = metrics(options);
      const response = trace(options, spec);
      const after = metrics(options);
      results.push(evaluateAssistantCase(spec, response, before, after));
    }
  }
  const passed = results.filter((result) => result.pass).length;
  const report = { schemaVersion: 1, repeats: options.repeat, passed, total: results.length, results };
  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : renderReport(report)}\n`);
  if (passed !== results.length) process.exitCode = 1;
}

if (path.resolve(process.argv[1] || "") === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
