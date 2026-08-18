import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const OPERATOR_SETUP_SCHEMA_VERSION = 1;
export const OPERATOR_SETUP_CONTRACT_PATH = fileURLToPath(
  new URL("../../contracts/operator-setup.json", import.meta.url),
);

const CONTRACT_FIELDS = Object.freeze([
  "schemaVersion",
  "contractId",
  "contractVersion",
  "mutationPolicies",
  "commands",
  "journeys",
  "settings",
]);
const POLICY_FIELDS = Object.freeze(["confirmationRequired", "exactSerialRequired"]);
const COMMAND_FIELDS = Object.freeze([
  "id",
  "tokens",
  "aliases",
  "lifecycle",
  "effect",
  "confirmationRequired",
  "exactSerialRequired",
  "summary",
  "usage",
  "documentationAnchor",
]);
const JOURNEY_FIELDS = Object.freeze(["id", "label", "commandIds", "steps"]);
const JOURNEY_STEP_FIELDS = Object.freeze([
  "id",
  "title",
  "commandId",
  "centerRoute",
  "surface",
  "verification",
  "documentationAnchor",
]);
const SETTING_FIELDS = Object.freeze(["name", "aliases", "group", "sensitivity", "home"]);
const JOURNEY_IDS = Object.freeze(["local", "contributor", "production", "pin"]);
const EFFECTS = Object.freeze([
  "read-only",
  "local-mutation",
  "remote-mutation",
  "device-mutation",
]);
const LIFECYCLES = Object.freeze(["current", "planned"]);
const GROUPS = Object.freeze(["local", "production", "provider", "pin"]);
const SENSITIVITIES = Object.freeze(["operational", "identity", "secret"]);
const HOMES = Object.freeze([
  "runtime.env",
  "center.env",
  "cosmos.env",
  "providers.env",
  "pin.env",
]);
const COMMAND_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const COMMAND_TOKEN = /^(?:--?[a-z][a-z0-9-]*|[a-z][a-z0-9-]*)$/;
const SETTING_NAME = /^[A-Z][A-Z0-9_]*$/;
const CONTRACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const DOCUMENTATION_ANCHOR = /^(?:README\.md|CONTRIBUTING\.md|docs\/[A-Za-z0-9._/-]+\.md)#[a-z0-9][a-z0-9-]*$/;
const CENTER_ROUTE = /^\/[A-Za-z0-9/_-]*$/;
const STEP_ID = /^[a-z][a-z0-9-]*$/;

const EXPECTED_POLICIES = Object.freeze({
  "read-only": Object.freeze({ confirmationRequired: false, exactSerialRequired: false }),
  "local-mutation": Object.freeze({ confirmationRequired: false, exactSerialRequired: false }),
  "remote-mutation": Object.freeze({ confirmationRequired: true, exactSerialRequired: false }),
  "device-mutation": Object.freeze({ confirmationRequired: true, exactSerialRequired: true }),
});

export class OperatorSetupContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OperatorSetupContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new OperatorSetupContractError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail("invalid-type", `${label} must be an object`);
  return value;
}

function requireExactFields(value, fields, label) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail("invalid-fields", `${label} fields must be exactly: ${fields.join(", ")}`);
  }
}

function requireArray(value, label, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail("invalid-type", `${label} must be an array with ${min}-${max} entries`);
  }
  return value;
}

function requireString(value, label, pattern, maximum = Number.POSITIVE_INFINITY) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !pattern.test(value)) {
    fail("invalid-string", `${label} has an invalid value`);
  }
  return value;
}

function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) fail("invalid-enum", `${label} must be one of: ${allowed.join(", ")}`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") fail("invalid-type", `${label} must be a boolean`);
  return value;
}

function validatePolicy(value, effect, label) {
  requireRecord(value, label);
  requireExactFields(value, POLICY_FIELDS, label);
  requireBoolean(value.confirmationRequired, `${label}.confirmationRequired`);
  requireBoolean(value.exactSerialRequired, `${label}.exactSerialRequired`);
  const expected = EXPECTED_POLICIES[effect];
  if (
    value.confirmationRequired !== expected.confirmationRequired ||
    value.exactSerialRequired !== expected.exactSerialRequired
  ) {
    fail("unsafe-policy", `${label} does not match the required ${effect} safety policy`);
  }
}

function validateTokens(value, label) {
  requireArray(value, label, { min: 1, max: 4 });
  value.forEach((token, index) => {
    requireString(token, `${label}[${index}]`, COMMAND_TOKEN, 80);
  });
}

function tokenKey(tokens) {
  return JSON.stringify(tokens);
}

function validateCommands(value, policies) {
  requireArray(value, "commands", { min: 1 });
  const ids = new Set();
  const paths = new Map();

  value.forEach((command, index) => {
    const label = `commands[${index}]`;
    requireRecord(command, label);
    requireExactFields(command, COMMAND_FIELDS, label);
    requireString(command.id, `${label}.id`, COMMAND_ID, 100);
    if (ids.has(command.id)) fail("duplicate-command", `duplicate command id: ${command.id}`);
    ids.add(command.id);
    validateTokens(command.tokens, `${label}.tokens`);
    requireArray(command.aliases, `${label}.aliases`);
    command.aliases.forEach((alias, aliasIndex) => {
      validateTokens(alias, `${label}.aliases[${aliasIndex}]`);
    });
    requireEnum(command.lifecycle, LIFECYCLES, `${label}.lifecycle`);
    requireEnum(command.effect, EFFECTS, `${label}.effect`);
    requireBoolean(command.confirmationRequired, `${label}.confirmationRequired`);
    requireBoolean(command.exactSerialRequired, `${label}.exactSerialRequired`);
    if (
      EXPECTED_POLICIES[command.effect].confirmationRequired &&
      !command.confirmationRequired
    ) {
      fail("unsafe-policy", `${label} must require confirmation for ${command.effect}`);
    }
    if (EXPECTED_POLICIES[command.effect].exactSerialRequired && !command.exactSerialRequired) {
      fail("unsafe-policy", `${label} must require an exact serial for ${command.effect}`);
    }
    validatePolicy(policies[command.effect], command.effect, `mutationPolicies.${command.effect}`);
    if (typeof command.summary !== "string" || command.summary.trim().length === 0 || command.summary.length > 120) {
      fail("invalid-string", `${label}.summary must be a concise nonblank string`);
    }
    if (typeof command.usage !== "string" || command.usage.trim().length === 0 || command.usage.length > 180) {
      fail("invalid-string", `${label}.usage must be a concise nonblank string`);
    }
    if (
      command.documentationAnchor !== null &&
      (typeof command.documentationAnchor !== "string" ||
        !DOCUMENTATION_ANCHOR.test(command.documentationAnchor))
    ) {
      fail("invalid-documentation-anchor", `${label}.documentationAnchor is invalid`);
    }

    for (const tokens of [command.tokens, ...command.aliases]) {
      const key = tokenKey(tokens);
      if (paths.has(key)) {
        fail(
          "duplicate-command-path",
          `command path ${tokens.join(" ")} is shared by ${paths.get(key)} and ${command.id}`,
        );
      }
      paths.set(key, command.id);
    }
  });

  return ids;
}

function validateJourneys(value, commandIds) {
  requireArray(value, "journeys", { min: JOURNEY_IDS.length, max: JOURNEY_IDS.length });
  const ids = new Set();
  value.forEach((journey, index) => {
    const label = `journeys[${index}]`;
    requireRecord(journey, label);
    requireExactFields(journey, JOURNEY_FIELDS, label);
    requireEnum(journey.id, JOURNEY_IDS, `${label}.id`);
    if (ids.has(journey.id)) fail("duplicate-journey", `duplicate journey id: ${journey.id}`);
    ids.add(journey.id);
    if (typeof journey.label !== "string" || journey.label.length === 0 || journey.label.length > 80) {
      fail("invalid-string", `${label}.label has an invalid value`);
    }
    requireArray(journey.commandIds, `${label}.commandIds`, { min: 1 });
    const seen = new Set();
    journey.commandIds.forEach((commandId, commandIndex) => {
      requireString(commandId, `${label}.commandIds[${commandIndex}]`, COMMAND_ID, 100);
      if (!commandIds.has(commandId)) {
        fail("unknown-command", `${label} references unknown command: ${commandId}`);
      }
      if (seen.has(commandId)) {
        fail("duplicate-journey-command", `${label} repeats command: ${commandId}`);
      }
      seen.add(commandId);
    });
    requireArray(journey.steps, `${label}.steps`, { min: 1 });
    const stepIds = new Set();
    journey.steps.forEach((step, stepIndex) => {
      const stepLabel = `${label}.steps[${stepIndex}]`;
      requireRecord(step, stepLabel);
      requireExactFields(step, JOURNEY_STEP_FIELDS, stepLabel);
      requireString(step.id, `${stepLabel}.id`, STEP_ID, 80);
      if (stepIds.has(step.id)) fail("duplicate-journey-step", `${label} repeats step: ${step.id}`);
      stepIds.add(step.id);
      if (typeof step.title !== "string" || step.title.trim().length === 0 || step.title.length > 80) {
        fail("invalid-string", `${stepLabel}.title must be a concise nonblank string`);
      }
      requireString(step.commandId, `${stepLabel}.commandId`, COMMAND_ID, 100);
      if (!commandIds.has(step.commandId)) {
        fail("unknown-command", `${stepLabel} references unknown command: ${step.commandId}`);
      }
      if (!journey.commandIds.includes(step.commandId)) {
        fail("journey-command-drift", `${stepLabel}.commandId is absent from ${label}.commandIds`);
      }
      if (
        step.centerRoute !== null &&
        (typeof step.centerRoute !== "string" || !CENTER_ROUTE.test(step.centerRoute))
      ) {
        fail("invalid-center-route", `${stepLabel}.centerRoute is invalid`);
      }
      requireEnum(step.surface, ["cli", "center", "manual"], `${stepLabel}.surface`);
      requireEnum(step.verification, ["cli", "center", "physical"], `${stepLabel}.verification`);
      requireString(
        step.documentationAnchor,
        `${stepLabel}.documentationAnchor`,
        DOCUMENTATION_ANCHOR,
        240,
      );
    });
  });
  for (const expected of JOURNEY_IDS) {
    if (!ids.has(expected)) fail("missing-journey", `journey is missing: ${expected}`);
  }
}

function validateSettings(value) {
  requireArray(value, "settings", { min: 1 });
  const names = new Map();
  value.forEach((setting, index) => {
    const label = `settings[${index}]`;
    requireRecord(setting, label);
    requireExactFields(setting, SETTING_FIELDS, label);
    requireString(setting.name, `${label}.name`, SETTING_NAME, 128);
    requireArray(setting.aliases, `${label}.aliases`);
    requireEnum(setting.group, GROUPS, `${label}.group`);
    requireEnum(setting.sensitivity, SENSITIVITIES, `${label}.sensitivity`);
    requireEnum(setting.home, HOMES, `${label}.home`);

    for (const name of [setting.name, ...setting.aliases]) {
      requireString(name, `${label}.name or alias`, SETTING_NAME, 128);
      if (names.has(name)) {
        fail("duplicate-setting", `setting name ${name} is declared by both ${names.get(name)} and ${setting.name}`);
      }
      names.set(name, setting.name);
    }
  });
  return names;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Validate untrusted data and return a detached, deeply immutable contract. */
export function parseOperatorSetupContract(document) {
  requireRecord(document, "operator setup contract");
  requireExactFields(document, CONTRACT_FIELDS, "operator setup contract");
  if (document.schemaVersion !== OPERATOR_SETUP_SCHEMA_VERSION) {
    fail(
      "schema-version",
      `operator setup schemaVersion must be ${OPERATOR_SETUP_SCHEMA_VERSION}`,
    );
  }
  if (document.contractId !== "operator-setup") {
    fail("contract-id", "operator setup contractId must be operator-setup");
  }
  requireString(document.contractVersion, "contractVersion", CONTRACT_VERSION, 30);

  requireRecord(document.mutationPolicies, "mutationPolicies");
  requireExactFields(document.mutationPolicies, EFFECTS, "mutationPolicies");
  for (const effect of EFFECTS) {
    validatePolicy(document.mutationPolicies[effect], effect, `mutationPolicies.${effect}`);
  }

  const commandIds = validateCommands(document.commands, document.mutationPolicies);
  validateJourneys(document.journeys, commandIds);
  validateSettings(document.settings);

  // JSON round-tripping makes the returned graph independent of the caller and
  // also guarantees the runtime object has the same data vocabulary as the
  // checked-in JSON contract.
  return deepFreeze(JSON.parse(JSON.stringify(document)));
}

/** Load the checked-in contract, or an explicitly supplied path for tooling/tests. */
export async function loadOperatorSetupContract(options = {}) {
  const contractPath =
    typeof options === "string" ? options : (options.contractPath ?? OPERATOR_SETUP_CONTRACT_PATH);
  let source;
  try {
    source = await readFile(contractPath, "utf8");
  } catch (error) {
    fail("read-failed", `could not read operator setup contract: ${error.message}`);
  }

  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    fail("invalid-json", `operator setup contract is not valid JSON: ${error.message}`);
  }
  return parseOperatorSetupContract(document);
}

export function operatorCommand(contract, id) {
  return contract.commands.find((command) => command.id === id) ?? null;
}

export function operatorJourney(contract, id) {
  return contract.journeys.find((journey) => journey.id === id) ?? null;
}

export function operatorSetting(contract, name) {
  return (
    contract.settings.find(
      (setting) => setting.name === name || setting.aliases.includes(name),
    ) ?? null
  );
}
