import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * THE DEPLOY HALF OF THE DASHBOARD'S CONFIGURATION WRITER.
 *
 * Center's operator console records a desired value for a setting into its own
 * /data volume and touches nothing under private/. `apply_configuration_proposals`
 * is the only thing that acts on that file, and it runs inside the deploy while
 * the private configuration is staged — so the new values and the new digests
 * land in the same deployment record as the release, and rollback keeps meaning
 * what it meant.
 *
 * Two properties are worth an acceptance test rather than a unit test, because
 * both fail SILENTLY and both fail across a language boundary:
 *
 *   THE TWO ALLOWLISTS ARE ONE LIST. Center refuses a name its catalog does not
 *   mark proposable; the deploy re-derives the same refusal independently,
 *   because Center is the public web app and a forged store file is what a
 *   compromise leaves behind. Two hand-maintained copies of a security-relevant
 *   list is a copy that drifts, and the drift shows up as either a setting the
 *   console offers and the deploy refuses (a broken deploy) or — much worse — a
 *   name the deploy will write that the console never authorized.
 *
 *   "EDITABLE" IS NOT "DELIVERED". Three settings §4 of
 *   center/src/server/configuration.ts calls safe to edit cannot be delivered by
 *   the env plane at all: two are Compose LITERALS, and CARRY_DEADLINE_MS is
 *   absent from the Center service's explicit environment allowlist. Each says
 *   so in its descriptor. If a later Compose change plumbs one of them through,
 *   the descriptor becomes a stale refusal and an operator is told to go and
 *   edit a file they no longer need to edit — so the claims are checked against
 *   production.yaml here rather than trusted.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const commonPath = path.join(root, "platform/deploy/vps/remote/common.sh");
const deployPath = path.join(root, "platform/deploy/vps/remote/deploy.sh");
const catalogPath = path.join(root, "center/src/server/configuration.ts");
const productionCompose = path.join(root, "platform/compose/production.yaml");
const baseCompose = path.join(root, "compose.yaml");

const commonSource = await readFile(commonPath, "utf8");
const deploySource = await readFile(deployPath, "utf8");
const catalogSource = await readFile(catalogPath, "utf8");

/**
 * The catalog's descriptors, read structurally rather than executed.
 *
 * The TypeScript cannot be imported from here — this suite runs with no
 * `center/node_modules` and `layout.sh` fails if one exists — so each `{ name:
 * "X", … }` block is sliced out and the three facts this test needs are read
 * off it. Nothing is inferred: a descriptor that stops carrying `editable`,
 * `home` or a delivery verdict fails the parse rather than defaulting.
 */
function readCatalog(source) {
  const settings = [];
  const nameMatcher = /\n\s{4}name: "([A-Z][A-Z0-9_]*)",\n/g;
  let match;
  while ((match = nameMatcher.exec(source)) !== null) {
    const start = match.index;
    const next = source.indexOf('\n    name: "', start + 1);
    const block = source.slice(start, next === -1 ? source.length : next);
    const home = /\n\s{4}home: "([a-z.]+)",/.exec(block);
    assert.ok(home, `${match[1]} declares no home`);
    settings.push({
      name: match[1],
      home: home[1],
      proposable: block.includes("...proposable("),
      undeliverable: block.includes("undeliverable("),
    });
  }
  return settings;
}

/** The deploy's own allowlist, read out of the python heredoc in common.sh. */
function readApplierAllowlist(source) {
  const table = /ALLOWED = \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(table, "apply_configuration_proposals must declare an ALLOWED table");
  const entries = new Map();
  for (const [, name, file] of table[1].matchAll(/"([A-Z][A-Z0-9_]*)": \("([a-z.]+)",/g)) {
    entries.set(name, file);
  }
  return entries;
}

/**
 * The applier's shell body.
 *
 * Sliced between the function's own header and the next one rather than at the
 * first line-initial `}` — the python heredoc inside it closes a dict at column
 * zero, so the obvious brace match stops a third of the way in and every "the
 * body does not do X" assertion below would be checking a third of the body.
 */
function applierBody() {
  const start = commonSource.indexOf("apply_configuration_proposals() {");
  assert.ok(start > 0, "apply_configuration_proposals must exist in common.sh");
  const end = commonSource.indexOf("\nnormalize_compatibility_aliases() {", start);
  assert.ok(end > start, "apply_configuration_proposals must stay above normalize_compatibility_aliases");
  return commonSource.slice(start, end);
}

const catalog = readCatalog(catalogSource);
const applier = readApplierAllowlist(commonSource);
const writable = catalog.filter((setting) => setting.proposable && !setting.undeliverable);

test("the dashboard and the deploy allow exactly the same settings, into the same files", () => {
  assert.ok(catalog.length > 20, "the catalog was not parsed");
  assert.ok(writable.length > 0, "no setting is writable, so the console is dead");

  assert.deepEqual(
    [...applier.keys()].sort(),
    writable.map((setting) => setting.name).sort(),
    "apply_configuration_proposals and the Center catalog disagree about what may be proposed",
  );

  for (const setting of writable) {
    assert.equal(
      applier.get(setting.name),
      setting.home,
      `${setting.name} is homed in ${setting.home} by the catalog and written to ${applier.get(setting.name)} by the deploy`,
    );
    // `compose` is not a file stage_private_configuration copies, so a value
    // "written into" it would land nowhere at all.
    assert.ok(["runtime.env", "cosmos.env", "providers.env", "center.env"].includes(setting.home));
  }
});

test("a setting the catalog calls undeliverable really is undeliverable", async () => {
  const [production, base] = await Promise.all([
    readFile(productionCompose, "utf8"),
    readFile(baseCompose, "utf8"),
  ]);
  const model = `${base}\n${production}`;

  for (const setting of catalog.filter((entry) => entry.undeliverable)) {
    // CARRY_REMOTE_TTS_ENABLED is undeliverable for a different reason: the
    // deploy writes it itself, after proposals are applied, once the speech
    // canary has proved the provider. That is checked below.
    if (setting.name === "CARRY_REMOTE_TTS_ENABLED") continue;
    const interpolated = new RegExp(`\\$\\{${setting.name}[:}]`).test(model);
    assert.equal(
      interpolated,
      false,
      `${setting.name} IS interpolated from the env plane now, so the console's refusal to edit it is stale`,
    );
  }

  // And the mirror of it: everything the console does offer has to be a name
  // the Compose model actually reads from an env file, or saving it would be
  // theatre — a value stored, deployed, and silently ignored.
  for (const setting of writable) {
    assert.match(
      model,
      new RegExp(`\\$\\{${setting.name}[:}]`),
      `${setting.name} is offered for editing but nothing in the Compose model reads it`,
    );
  }
});

test("proposals are applied to the candidate, after the values that would overwrite them", () => {
  const applyAt = deploySource.indexOf('apply_configuration_proposals "$stage_env"');
  const captureAt = deploySource.indexOf('capture_live_center_env "$stage_env/center.env"');
  const ttsAt = deploySource.indexOf('update_env_value "$cosmos_stage" CARRY_REMOTE_TTS_ENABLED true');
  assert.ok(applyAt > 0, "the deploy must apply pending configuration proposals");

  // capture_live_center_env re-imports KEYCLOAK_SCOPES from the RUNNING Center
  // container. Applying before it would overwrite a proposal with the value it
  // was meant to replace, and the operator would see the change saved, deployed
  // and ineffective.
  assert.ok(captureAt > 0 && captureAt < applyAt, "proposals must be applied after the live Center env is captured");

  // The speech canary sets CARRY_REMOTE_TTS_ENABLED itself once it has proved
  // the provider returns real audio. That is why the catalog marks that setting
  // undeliverable, and this ordering is what makes the claim true.
  assert.ok(ttsAt > applyAt, "the speech canary must remain the last writer of CARRY_REMOTE_TTS_ENABLED");

  // The staged candidate only. Nothing about this may touch a live protected
  // file: config-digests.tsv is what makes rollback trustworthy.
  const body = applierBody();
  for (const live of ["$RUNTIME_ENV", "$COSMOS_ENV", "$PROVIDER_ENV", "$CENTER_ENV", "$PRIVATE_DIR"]) {
    assert.ok(
      !body.includes(live),
      `apply_configuration_proposals must not name the live ${live}`,
    );
  }
  // Read-only with respect to Center's data volume: the store is desired state,
  // so nothing has to be marked consumed and no writer for it exists inside the
  // deploy transaction, where a failed write would be a failed deploy.
  for (const write of [
    />\s*"\$store"/,
    />>\s*"\$store"/,
    /\brm\b[^\n]*\$store/,
    /\bmv\b[^\n]*\$store/,
    /\binstall\b[^\n]*\$store/,
    /\bchmod\b[^\n]*\$store/,
    /\$CENTER_DATA_DIR"?\/[^\n]*>/,
  ]) {
    assert.doesNotMatch(body, write, "the deploy must only read the proposal store");
  }
});

/** Run apply_configuration_proposals against a scratch store and staged env. */
function applyInScratch(work, store) {
  return spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
source ${JSON.stringify(commonPath)}
CENTER_DATA_DIR=${JSON.stringify(path.join(work, "center-data"))}
apply_configuration_proposals ${JSON.stringify(path.join(work, "stage"))}`,
    ],
    { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH } },
  );
}

async function scratch(settings) {
  const work = await mkdtemp(path.join(os.tmpdir(), "configuration-proposals-"));
  await mkdir(path.join(work, "center-data"));
  await mkdir(path.join(work, "stage"));
  for (const file of ["runtime.env", "cosmos.env", "providers.env", "center.env"]) {
    await writeFile(path.join(work, "stage", file), "");
  }
  if (settings !== null) {
    await writeFile(
      path.join(work, "center-data", "configuration-proposals.json"),
      typeof settings === "string" ? settings : JSON.stringify({ schemaVersion: 1, settings }),
    );
  }
  return work;
}

test("an absent store is the normal state and changes nothing", async () => {
  const work = await scratch(null);
  const result = applyInScratch(work);
  assert.equal(result.status, 0, result.stderr);
  for (const file of await readdir(path.join(work, "stage"))) {
    assert.equal(await readFile(path.join(work, "stage", file), "utf8"), "");
  }
});

test("a valid proposal reaches every staged file that decides the effective value", async () => {
  // All four env files are Compose --env-file arguments and the LAST one wins,
  // so writing only the home would let a stale value in a later file quietly
  // win — saved, deployed, ineffective, with nothing said.
  const work = await scratch({
    CARRY_LLM_MODEL: { value: "openai/gpt-4o-mini", proposedAt: "2026-08-12T10:00:00.000Z" },
    KEYCLOAK_SCOPES: { value: "openid email profile", proposedAt: "2026-08-12T10:00:00.000Z" },
  });
  await writeFile(path.join(work, "stage", "runtime.env"), "CARRY_LLM_MODEL=stale/model\n");

  const result = applyInScratch(work);
  assert.equal(result.status, 0, result.stderr);

  const read = async (file) => readFile(path.join(work, "stage", file), "utf8");
  assert.match(await read("providers.env"), /^CARRY_LLM_MODEL=openai\/gpt-4o-mini$/m);
  assert.match(await read("runtime.env"), /^CARRY_LLM_MODEL=openai\/gpt-4o-mini$/m);
  assert.doesNotMatch(await read("runtime.env"), /stale\/model/);
  assert.match(await read("center.env"), /^KEYCLOAK_SCOPES=openid email profile$/m);
  // A name nothing already carried is not scattered into files that never had it.
  assert.equal(await read("cosmos.env"), "");

  // The value is not echoed. These are not secrets, but the deploy's output is
  // shared and the store is the record that carries values.
  assert.doesNotMatch(result.stdout, /gpt-4o-mini/);
  assert.match(result.stdout, /applied dashboard configuration proposal: CARRY_LLM_MODEL/);
});

test("the deploy refuses the whole store rather than applying the part it likes", async () => {
  const cases = [
    [
      { AUTH_SESSION_SECRET: { value: "0".repeat(32), proposedAt: "" } },
      /AUTH_SESSION_SECRET is not a setting the dashboard may propose/,
    ],
    [
      { CARRY_PG_PASSWORD: { value: "x", proposedAt: "" } },
      /CARRY_PG_PASSWORD is not a setting the dashboard may propose/,
    ],
    // The name IS proposable in the catalog and is NOT deliverable, so the
    // deploy must not write it either — the two lists agreeing is the point.
    [
      { CARRY_DEADLINE_MS: { value: "9000", proposedAt: "" } },
      /CARRY_DEADLINE_MS is not a setting the dashboard may propose/,
    ],
    [
      { KEYCLOAK_SCOPES: { value: "email profile", proposedAt: "" } },
      /must include openid/,
    ],
    [
      { CARRY_LLM_MODEL: { value: "a b", proposedAt: "" } },
      /not a usable provider model identifier/,
    ],
    [{ CARRY_LLM_MODEL: { value: " ok/model", proposedAt: "" } }, /whitespace/],
    // The SHARED guard, which every kind is checked against before its own
    // grammar. Reached here through the one setting whose grammar does not
    // bound its own length: a scope list is any number of well-formed tokens, so
    // without the shared length check a forged store could put an arbitrarily
    // long line into center.env and every per-kind rule would still be satisfied.
    [
      { KEYCLOAK_SCOPES: { value: `openid ${"a".repeat(600)}`, proposedAt: "" } },
      /KEYCLOAK_SCOPES is empty, too long, or contains something other than printable ASCII/,
    ],
    ['{"schemaVersion":2,"settings":{}}', /schema version 1/],
    ["{ not json", /could not be parsed/],
  ];

  for (const [settings, expected] of cases) {
    const work = await scratch(settings);
    // A second, valid entry alongside the bad one: if the applier applied what
    // it liked and skipped the rest, this file would come back changed.
    if (typeof settings !== "string") {
      settings.CARRY_VISION_MODEL = { value: "openai/gpt-4o-mini", proposedAt: "" };
      await writeFile(
        path.join(work, "center-data", "configuration-proposals.json"),
        JSON.stringify({ schemaVersion: 1, settings }),
      );
    }
    const result = applyInScratch(work);
    assert.notEqual(result.status, 0, `expected a refusal for ${JSON.stringify(settings)}`);
    assert.match(result.stderr + result.stdout, expected);
    assert.equal(await readFile(path.join(work, "stage", "runtime.env"), "utf8"), "");
  }
});

test("a store that is not a regular file is refused outright", async () => {
  const work = await scratch(null);
  await writeFile(path.join(work, "elsewhere.json"), JSON.stringify({ schemaVersion: 1, settings: {} }));
  // A symlink here would be an attempt to make the deploy read something other
  // than what Center wrote, and there is no benign reason for one.
  await symlink(
    path.join(work, "elsewhere.json"),
    path.join(work, "center-data", "configuration-proposals.json"),
  );
  const result = applyInScratch(work);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a regular file/);
});

test("nothing in the deploy path can bypass the writer's own gate", () => {
  // The console is the only writer, and the deploy is the only applier. Neither
  // half may grow an option that skips the other's check.
  const body = applierBody();
  assert.doesNotMatch(body, /--force|skip|ignore|--no-verify/i);
  assert.equal(
    (deploySource.match(/apply_configuration_proposals/g) ?? []).length,
    1,
    "the deploy must apply pending proposals exactly once",
  );
  for (const driver of ["rollback.sh", "backup.sh", "canary.sh", "drift.sh", "preflight.sh"]) {
    const source = spawnSync("grep", ["-c", "apply_configuration_proposals", path.join(root, "platform/deploy/vps/remote", driver)], {
      encoding: "utf8",
    });
    assert.equal(source.stdout.trim(), "0", `${driver} must not apply configuration proposals`);
  }
});
