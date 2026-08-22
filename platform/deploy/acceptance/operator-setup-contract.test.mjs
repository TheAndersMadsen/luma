import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OPERATOR_SETUP_CONTRACT_PATH,
  OPERATOR_SETUP_SCHEMA_VERSION,
  OperatorSetupContractError,
  loadOperatorSetupContract,
  operatorCommand,
  operatorJourney,
  operatorSetting,
  parseOperatorSetupContract,
} from "../../contracts/operator-setup.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const schemaPath = path.join(root, "contracts/operator-setup.schema.json");
const envExamplePath = path.join(root, ".env.example");

const CURRENT_COMMAND_IDS = Object.freeze([
  "init",
  "doctor.local",
  "doctor.production",
  "stack.build",
  "stack.up",
  "stack.down",
  "stack.status",
  "stack.logs",
  "stack.config",
  "dev.center",
  "dev.down",
  "check.center",
  "check.cosmos",
  "check.platform",
  "check.changed",
  "test",
  "release.check",
  "release.build",
  "release.verify",
  "pin.doctor",
  "pin.check",
  "pin.release.build",
  "pin.release.inspect",
  "pin.release.verify",
  "pin.release.plan",
  "pin.release.ship",
  "pin.install",
  "deploy.production",
  "deploy.carry-baseline",
  "backup",
  "canary",
  "drift",
  "adopt-config",
  "prune-state",
  "rollback",
]);

const NEW_COMMAND_IDS = Object.freeze([
  "setup.local",
  "setup.contributor",
  "setup.production",
  "setup.pin",
  "setup.resume",
  "setup.status",
  "setup.import.vps-candidate",
  "setup.import.pin-release",
  "setup.artifacts.vps",
  "setup.artifacts.pin",
  "config.get",
  "config.set",
  "config.check",
  "config.path",
  "config.list",
  "config.template",
  "pki.init",
  "pki.import",
  "support-bundle",
  "version",
  "pin.activate",
  "pin.activate.status",
  "pin.network",
  "pin.network.qr",
]);

function mutable(contract) {
  return JSON.parse(JSON.stringify(contract));
}

function expectCode(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof OperatorSetupContractError);
    assert.equal(error.code, code);
    return true;
  });
}

function envNames(source) {
  return [...source.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]).sort();
}

function documentationHeadingSlug(heading) {
  return heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ +/g, "-");
}

async function assertDocumentationAnchor(anchor) {
  const [relativePath, fragment] = anchor.split("#");
  assert.ok(relativePath && fragment, `invalid documentation anchor: ${anchor}`);
  const source = await readFile(path.join(root, relativePath), "utf8");
  const slugs = [...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
    documentationHeadingSlug(match[1]),
  );
  assert.ok(slugs.includes(fragment), `${anchor} does not name a heading`);
}

test("the checked-in setup contract loads as one immutable versioned model", async () => {
  const contract = await loadOperatorSetupContract();
  assert.equal(OPERATOR_SETUP_CONTRACT_PATH, path.join(root, "contracts/operator-setup.json"));
  assert.equal(contract.schemaVersion, OPERATOR_SETUP_SCHEMA_VERSION);
  assert.equal(contract.contractId, "operator-setup");
  assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  assert.ok(Object.isFrozen(contract));
  assert.ok(Object.isFrozen(contract.commands));
  assert.ok(Object.isFrozen(contract.commands[0]));

  assert.equal(operatorCommand(contract, "pin.install")?.effect, "device-mutation");
  assert.equal(operatorJourney(contract, "pin")?.steps.at(-1)?.id, "confirm");
  assert.equal(operatorSetting(contract, "COSMOS_ADMIN_TOKEN")?.name, "REVIVAL_ADMIN_TOKEN");
  assert.equal(operatorCommand(contract, "does.not.exist"), null);

  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.properties.schemaVersion.const, OPERATOR_SETUP_SCHEMA_VERSION);
  assert.deepEqual(schema.required, [
    "schemaVersion",
    "contractId",
    "contractVersion",
    "mutationPolicies",
    "commands",
    "journeys",
    "settings",
  ]);
});

test("all existing and new operator commands are represented exactly once", async () => {
  const contract = await loadOperatorSetupContract();
  const ids = contract.commands.map((command) => command.id);
  assert.deepEqual([...new Set(ids)].sort(), [...ids].sort(), "command ids must be unique");
  for (const id of [...CURRENT_COMMAND_IDS, ...NEW_COMMAND_IDS]) {
    assert.ok(ids.includes(id), `operator command is absent from the contract: ${id}`);
  }
  assert.deepEqual(
    contract.commands.filter((command) => CURRENT_COMMAND_IDS.includes(command.id)).map((command) => command.id).sort(),
    [...CURRENT_COMMAND_IDS].sort(),
  );

  const paths = contract.commands.flatMap((command) => [command.tokens, ...command.aliases]);
  assert.deepEqual(
    paths.map((tokens) => JSON.stringify(tokens)).sort(),
    [...new Set(paths.map((tokens) => JSON.stringify(tokens)))].sort(),
    "command paths and short aliases must be unique",
  );
  for (const alias of ["build", "up", "down", "status", "logs", "config"]) {
    assert.ok(paths.some((tokens) => tokens.length === 1 && tokens[0] === alias));
  }
});

test("mutation classes fail closed at the remote and physical boundaries", async () => {
  const contract = await loadOperatorSetupContract();
  assert.deepEqual(contract.mutationPolicies["remote-mutation"], {
    confirmationRequired: true,
    exactSerialRequired: false,
  });
  assert.deepEqual(contract.mutationPolicies["device-mutation"], {
    confirmationRequired: true,
    exactSerialRequired: true,
  });

  for (const command of contract.commands) {
    if (command.effect === "remote-mutation" || command.effect === "device-mutation") {
      assert.equal(command.confirmationRequired, true, `${command.id} must require confirmation`);
    }
    if (command.effect === "device-mutation") {
      assert.equal(command.exactSerialRequired, true, `${command.id} must require an exact serial`);
    }
  }
  for (const id of ["pki.init", "pki.import"]) {
    assert.equal(operatorCommand(contract, id).confirmationRequired, true);
  }
  for (const id of ["pin.activate", "pin.activate.status", "pin.network"]) {
    assert.equal(operatorCommand(contract, id).exactSerialRequired, true, `${id} must bind one Pin`);
  }
  assert.deepEqual(
    {
      effect: operatorCommand(contract, "pin.network.qr").effect,
      exactSerialRequired: operatorCommand(contract, "pin.network.qr").exactSerialRequired,
    },
    { effect: "local-mutation", exactSerialRequired: false },
    "the browser-local QR helper neither accepts nor resolves a device serial",
  );
  assert.equal(
    operatorCommand(contract, "setup.resume").effect,
    "read-only",
    "resume must only recompute evidence for the selected track",
  );
  for (const id of ["test", "release.check", "pin.check", "setup.artifacts.vps", "setup.artifacts.pin"]) {
    assert.equal(
      operatorCommand(contract, id).effect,
      "local-mutation",
      `${id} may write external build/cache state and must not claim read-only`,
    );
  }

  const unsafeRemote = mutable(contract);
  operatorCommand(unsafeRemote, "pin.release.ship").confirmationRequired = false;
  expectCode(() => parseOperatorSetupContract(unsafeRemote), "unsafe-policy");

  const unsafeDevice = mutable(contract);
  operatorCommand(unsafeDevice, "pin.install").exactSerialRequired = false;
  expectCode(() => parseOperatorSetupContract(unsafeDevice), "unsafe-policy");
});

test("journeys expose ordered CLI, Center, and physical verification steps", async () => {
  const contract = await loadOperatorSetupContract();
  assert.deepEqual(contract.journeys.map((journey) => journey.id), [
    "local",
    "contributor",
    "production",
    "pin",
  ]);
  for (const journey of contract.journeys) {
    assert.ok(journey.steps.length > 0);
    for (const step of journey.steps) {
      assert.ok(journey.commandIds.includes(step.commandId));
      assert.ok(["cli", "center", "manual"].includes(step.surface));
      assert.ok(["cli", "center", "physical"].includes(step.verification));
      await assertDocumentationAnchor(step.documentationAnchor);
    }
  }

  const pin = operatorJourney(contract, "pin");
  assert.deepEqual(pin.steps.map((step) => step.id), [
    "connect",
    "inspect",
    "release",
    "ship",
    "install",
    "configure",
    "identity",
    "activate",
    "network",
    "confirm",
  ]);
  assert.ok(pin.steps.some((step) => step.surface === "cli"));
  assert.ok(pin.steps.some((step) => step.centerRoute === "/settings/pin/install"));
  assert.ok(pin.steps.some((step) => step.verification === "physical"));
});

test("command help metadata is concise and points at real documentation", async () => {
  const contract = await loadOperatorSetupContract();
  for (const command of contract.commands) {
    assert.ok(command.summary.trim());
    assert.ok(command.usage.trim());
    assert.doesNotMatch(command.usage, /[;&|`$><\n\r]/, `${command.id} usage must not be shell code`);
    if (command.documentationAnchor !== null) {
      await assertDocumentationAnchor(command.documentationAnchor);
    }
  }
  assert.deepEqual(
    contract.commands.filter((command) => command.documentationAnchor === null).map((command) => command.id),
    ["support-bundle"],
    "only the intentionally undocumented support-bundle command may omit an anchor",
  );
});

test("the settings catalog covers .env.example without containing values", async () => {
  const [contract, envSource] = await Promise.all([
    loadOperatorSetupContract(),
    readFile(envExamplePath, "utf8"),
  ]);
  const declared = contract.settings.flatMap((setting) => [setting.name, ...setting.aliases]).sort();
  assert.deepEqual(declared, envNames(envSource));

  assert.deepEqual([...new Set(contract.settings.map((setting) => setting.group))].sort(), [
    "local",
    "pin",
    "production",
    "provider",
  ]);
  assert.ok(contract.settings.some((setting) => setting.sensitivity === "secret"));
  assert.ok(contract.settings.some((setting) => setting.sensitivity === "identity"));
  assert.ok(contract.settings.some((setting) => setting.aliases.length > 0));

  for (const setting of contract.settings) {
    assert.deepEqual(Object.keys(setting).sort(), ["aliases", "group", "home", "name", "sensitivity"]);
    assert.ok(!("value" in setting));
    assert.ok(!("default" in setting));
    assert.ok(!("example" in setting));
  }
});

test("semantic drift and unsafe additions are rejected before consumers see them", async () => {
  const contract = await loadOperatorSetupContract();

  const unknownStep = mutable(contract);
  unknownStep.journeys[0].steps[0].commandId = "missing.command";
  expectCode(() => parseOperatorSetupContract(unknownStep), "unknown-command");

  const duplicateSetting = mutable(contract);
  duplicateSetting.settings[1].aliases.push(duplicateSetting.settings[0].name);
  expectCode(() => parseOperatorSetupContract(duplicateSetting), "duplicate-setting");

  const shellPath = mutable(contract);
  shellPath.commands[0].tokens = ["init;rm"];
  expectCode(() => parseOperatorSetupContract(shellPath), "invalid-string");

  const badDocs = mutable(contract);
  badDocs.commands[0].documentationAnchor = "https://example.invalid/setup";
  expectCode(() => parseOperatorSetupContract(badDocs), "invalid-documentation-anchor");
});
